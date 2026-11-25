// The daily backup and how many are kept (spec 14, part 2; UP-21), on SQLite and PostgreSQL: the hour in the site's own time zone,
// catching up after a server was off, the keeping rules, a failure that is tried again and told once a day.
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { localAdapter, type StorageAdapter } from "@oks-page/media";
import { newId } from "@oks-page/db";
import { openMemoryDatabase } from "@oks-page/db/memory";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  listBackupFiles,
  pruneBackups,
  toPrune,
  type BackupContext,
  type BackupInfo,
  type BackupKind,
} from "./backup.js";
import {
  dailyBackupOn,
  dailyDue,
  dailySlotStart,
  lastGoodBackup,
  loadBackupState,
  RETRY_AFTER_MS,
  runDailyBackup,
  saveDailyBackupOn,
} from "./backup-schedule.js";
import type { Actor } from "./content.js";
import {
  EMAIL_JOB,
  emailJobHandler,
  saveEmailSettings,
  type MakeTransport,
  type OutgoingEmail,
} from "./email.js";
import { sendBackupFailedEmails } from "./emails.js";
import { drainJobs } from "./jobs.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";

const at = (iso: string) => Date.parse(iso);
const info = (kind: BackupKind, iso: string, name = `${kind}-${iso}`): BackupInfo => ({
  name,
  kind,
  createdAt: at(iso),
  size: 1,
  checkedAt: at(iso),
  rows: 1,
  files: 0,
  compatible: true,
});
const actorFor = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (c) => caps.includes(c) };
};

describe("the hour of the daily backup", () => {
  test("it is 03:00 on the wall clock of the site's own zone, UTC without one", () => {
    expect(dailySlotStart(at("2026-11-26T12:00:00Z"), null)).toBe(at("2026-11-26T03:00:00Z"));
    expect(dailySlotStart(at("2026-11-26T12:00:00Z"), "UTC")).toBe(at("2026-11-26T03:00:00Z"));
    // 20:00 UTC is 01:30 the next morning in India: today's slot is 03:00 of that day, which is 21:30 UTC the day before.
    expect(dailySlotStart(at("2026-11-26T20:00:00Z"), "Asia/Kolkata")).toBe(
      at("2026-11-26T21:30:00Z"),
    );
    expect(dailySlotStart(at("2026-11-26T12:00:00Z"), "Asia/Kolkata")).toBe(
      at("2026-11-25T21:30:00Z"),
    );
    // Berlin on the day the clocks go forward: 03:00 summer time is 01:00 UTC.
    expect(dailySlotStart(at("2026-03-29T10:00:00Z"), "Europe/Berlin")).toBe(
      at("2026-03-29T01:00:00Z"),
    );
    expect(dailySlotStart(at("2026-11-26T12:00:00Z"), "UTC", 0)).toBe(at("2026-11-26T00:00:00Z"));
  });

  test("a daily backup is due once today's hour has come and none was made since; other kinds do not count", () => {
    const yesterday = info("daily", "2026-11-25T03:00:05Z");
    expect(dailyDue([], at("2026-11-26T02:59:00Z"), null)).toBe(false);
    expect(dailyDue([], at("2026-11-26T03:00:00Z"), null)).toBe(true);
    expect(dailyDue([yesterday], at("2026-11-26T02:59:00Z"), null)).toBe(false);
    expect(dailyDue([yesterday], at("2026-11-26T09:00:00Z"), null)).toBe(true);
    expect(
      dailyDue(
        [yesterday, info("daily", "2026-11-26T03:00:09Z")],
        at("2026-11-26T09:00:00Z"),
        null,
      ),
    ).toBe(false);
    // A person's own backup, or a safety copy, is not the daily one.
    expect(
      dailyDue(
        [yesterday, info("manual", "2026-11-26T04:00:00Z"), info("safety", "2026-11-26T05:00:00Z")],
        at("2026-11-26T09:00:00Z"),
        null,
      ),
    ).toBe(true);
    // A server that was off for days makes one backup when it starts, not one for every day missed.
    expect(
      dailyDue([info("daily", "2026-11-20T03:00:00Z")], at("2026-11-26T09:00:00Z"), null),
    ).toBe(true);
  });
});

describe("how many are kept", () => {
  test("14 daily ones, and the newest of each of the 6 months before them", () => {
    const all: BackupInfo[] = [];
    // One a day from 10 May to 26 November 2026: 201 daily backups.
    for (let t = at("2026-05-10T03:00:00Z"); t <= at("2026-11-26T03:00:00Z"); t += 86_400_000)
      all.push(info("daily", new Date(t).toISOString()));
    const gone = new Set(toPrune(all));
    const kept = all.filter((b) => !gone.has(b.name));
    expect(kept).toHaveLength(14 + 6);
    // The newest 14 days.
    for (const b of all.slice(-14)) expect(gone.has(b.name), b.name).toBe(false);
    // Then the last day of Nov (the 12th: the newest of what is left of it), Oct, Sep, Aug, Jul, Jun; May is let go.
    const months = kept
      .slice(0, kept.length - 14)
      .map((b) => new Date(b.createdAt).toISOString().slice(0, 10));
    expect(months).toEqual([
      "2026-06-30",
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
      "2026-10-31",
      "2026-11-12",
    ]);
  });

  test("a person's own, safety and agency backups are kept apart, the newest 10 of each", () => {
    const all: BackupInfo[] = [];
    for (const kind of ["manual", "safety", "remote"] as BackupKind[])
      for (let i = 0; i < 13; i++)
        all.push(info(kind, new Date(at("2026-11-01T10:00:00Z") + i * 3_600_000).toISOString()));
    const gone = toPrune(all);
    expect(gone).toHaveLength(9); // 3 of each
    for (const kind of ["manual", "safety", "remote"])
      expect(gone.filter((n) => n.startsWith(kind))).toHaveLength(3);
    expect(gone).toContain("manual-2026-11-01T10:00:00.000Z");
    expect(gone).not.toContain("manual-2026-11-01T22:00:00.000Z");
  });

  test("on the disk the newest backup is never deleted, and a backup goes with its note", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oks-prune-"));
    try {
      const ctx = {
        dir,
        storage: localAdapter({ root: path.join(dir, "u"), baseUrl: "/u" }),
      } as unknown as BackupContext;
      const names: string[] = [];
      for (let i = 0; i < 12; i++) {
        const name = `manual-202611${String(10 + i).padStart(2, "0")}-100000-${String(i)
          .padStart(6, "0")
          .replace(/[^0-9a-f]/g, "a")}.tgz`;
        names.push(name);
        await writeFile(path.join(dir, name), "x");
        await writeFile(
          path.join(dir, `${name}.json`),
          JSON.stringify({ kind: "manual", createdAt: at(`2026-11-${10 + i}T10:00:00Z`) }),
        );
      }
      expect(await pruneBackups(ctx)).toBe(2);
      const left = (await readdir(dir)).sort();
      expect(left).toHaveLength(20); // 10 backups and their 10 notes
      expect(left).not.toContain(names[0]);
      expect(left).not.toContain(`${names[0]}.json`);
      expect(left).toContain(names[11]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the daily backup`, () => {
    let db: TestDb;
    let dir: string;
    let storage: StorageAdapter;
    let ctx: BackupContext;
    let siteId = "";
    let anna: Actor;
    let eve: Actor;
    let clock = at("2026-11-26T02:00:00Z");
    let free: number | null = null;
    const secrets = new SiteSecrets("x".repeat(40));
    let sent: OutgoingEmail[] = [];
    const accepting: MakeTransport = () => ({
      send: async (email) => {
        sent.push(email);
      },
    });
    const told: string[] = [];
    const daily = (zone: string | null = null) =>
      runDailyBackup(db.runner, ctx, siteId, {
        zone,
        now: () => clock,
        notify: async (reason) => {
          told.push(reason);
        },
      });
    const dailies = async () => (await listBackupFiles(ctx)).filter((b) => b.kind === "daily");

    beforeEach(async () => {
      db = await open();
      dir = await mkdtemp(path.join(tmpdir(), "oks-daily-"));
      storage = localAdapter({ root: path.join(dir, "uploads"), baseUrl: "/uploads" });
      clock = at("2026-11-26T02:00:00Z");
      free = null;
      sent = [];
      told.length = 0;
      ctx = {
        dir: path.join(dir, "backups"),
        storage,
        openCopy: () => openMemoryDatabase(),
        now: () => clock,
        freeBytes: async () => free,
      };
      const setup = await runSetup(
        db.runner,
        async (input) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, input.name, input.email, new Date(clock), new Date(clock)],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@garden.test", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      anna = actorFor(setup.userId, "administrator");
      eve = actorFor(setup.userId, "editor");
    });
    afterEach(async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    test("it is made when the hour has come, once a day, and again the next day (UP-21)", async () => {
      expect(await daily()).toBe("not due"); // 02:00, before the hour
      clock = at("2026-11-26T04:00:00Z");
      expect(await daily()).toBe("made");
      expect((await dailies()).map((b) => b.kind)).toEqual(["daily"]);
      expect((await lastGoodBackup(ctx))?.kind).toBe("daily");
      clock = at("2026-11-26T09:00:00Z");
      expect(await daily()).toBe("not due");
      clock = at("2026-11-27T03:30:00Z");
      expect(await daily()).toBe("made");
      expect(await dailies()).toHaveLength(2);
    });

    test("a server that was off makes one backup when it starts, and the site's own zone sets the hour", async () => {
      clock = at("2026-11-26T20:00:00Z"); // 01:30 on the 27th in India: today's 03:00 has not come
      expect(await daily("Asia/Kolkata")).toBe("not due");
      clock = at("2026-11-26T22:00:00Z"); // 03:30 in India
      expect(await daily("Asia/Kolkata")).toBe("made");
      clock = at("2026-12-10T12:00:00Z"); // off for two weeks
      expect(await daily("Asia/Kolkata")).toBe("made");
      expect(await dailies()).toHaveLength(2);
    });

    test("it can be turned off, only by people who manage the site, and is on until then", async () => {
      expect(await dailyBackupOn(db.runner, siteId)).toBe(true);
      expect(await saveDailyBackupOn(db.runner, eve, siteId, false)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await saveDailyBackupOn(db.runner, anna, siteId, "no")).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await saveDailyBackupOn(db.runner, anna, siteId, false)).toEqual({
        ok: true,
        daily: false,
      });
      clock = at("2026-11-26T04:00:00Z");
      expect(await daily()).toBe("off");
      expect(await dailies()).toHaveLength(0);
      await saveDailyBackupOn(db.runner, anna, siteId, true);
      expect(await daily()).toBe("made");
    });

    test("20 days of daily backups leave the newest 14 and the newest of the older ones of the month", async () => {
      for (let d = 0; d < 20; d++) {
        clock = at("2026-11-01T04:00:00Z") + d * 86_400_000;
        expect(await daily()).toBe("made");
      }
      const kept = await dailies();
      expect(kept).toHaveLength(15);
      // The 14 newest (7 to 20 November) and 6 November, the newest of the older ones.
      const days = kept.map((b) => new Date(b.createdAt).toISOString().slice(8, 10)).sort();
      expect(days).toEqual([
        "06",
        "07",
        "08",
        "09",
        "10",
        "11",
        "12",
        "13",
        "14",
        "15",
        "16",
        "17",
        "18",
        "19",
        "20",
      ]);
    });

    test("when it fails, it waits an hour, tells once a day, and clears when a backup works", async () => {
      free = 1024; // no room
      clock = at("2026-11-26T04:00:00Z");
      expect(await daily()).toBe("failed");
      expect(told).toHaveLength(1);
      expect(told[0]).toMatch(/not enough free disk space/);
      let state = await loadBackupState(db.runner, siteId);
      expect(state).toMatchObject({ failedAt: clock, triedAt: clock });
      expect(state.failure).toMatch(/not enough free disk space/);

      clock += 30 * 60 * 1000;
      expect(await daily()).toBe("waiting");
      clock += RETRY_AFTER_MS;
      expect(await daily()).toBe("failed"); // tried again, failed again
      expect(told).toHaveLength(1); // but not told again so soon
      clock += 24 * 60 * 60 * 1000 + 1;
      expect(await daily()).toBe("failed");
      expect(told).toHaveLength(2); // a day later it is told again

      free = null;
      clock += RETRY_AFTER_MS;
      expect(await daily()).toBe("made");
      state = await loadBackupState(db.runner, siteId);
      expect(state).toMatchObject({ failedAt: null, failure: "" });
    });

    test("the administrators get an email with the reason, at most one a day", async () => {
      const saved = await saveEmailSettings(
        db.runner,
        anna,
        siteId,
        secrets,
        {
          host: "smtp.example.com",
          port: 587,
          security: "starttls",
          username: "u",
          password: "p",
          fromName: "Anna",
          fromAddress: "hello@garden.example",
          testTo: "anna@garden.test",
        },
        { makeTransport: accepting },
      );
      expect(saved.ok).toBe(true);
      sent = [];
      const input = {
        reason: "There is not enough free disk space for a backup.",
        siteName: "Anna's Garden",
        link: "https://garden.example/admin/tools/backups",
      };
      const now = () => clock;
      expect(await sendBackupFailedEmails(db.runner, siteId, secrets, input, now)).toBe(1);
      await drainJobs(
        db.runner,
        { [EMAIL_JOB]: emailJobHandler(db.runner, secrets, { makeTransport: accepting, now }) },
        { now },
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        to: "anna@garden.test",
        subject: "The backup of Anna's Garden failed",
      });
      expect(sent[0]!.text).toContain("not enough free disk space");
      expect(sent[0]!.text).toContain("https://garden.example/admin/tools/backups");
      expect(await sendBackupFailedEmails(db.runner, siteId, secrets, input, now)).toBe(0);
      clock += 25 * 60 * 60 * 1000;
      expect(await sendBackupFailedEmails(db.runner, siteId, secrets, input, now)).toBe(1);
    });
  });
}
