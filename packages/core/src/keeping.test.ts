// How long personal data is kept (spec 18, section 6; PR-08): the default of each kind, how an owner may shorten it and never
// lengthen it, and the daily job that deletes what is past its time, to the day, for each site with its own times. In
// SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  KEEPING_RULES,
  loadKeeping,
  purgeAuditLog,
  purgeConsentRecords,
  purgeEmailLog,
  purgeSearchCounts,
  runKeeping,
  saveKeeping,
} from "./keeping.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000161";
const SITE2 = "SITE0000000000000000000162";
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const admin: Actor = { userId: "USER0000000000000000000161", can: (c) => c === "settings.manage" };
const nobody: Actor = { userId: "USER0000000000000000000161", can: () => false };
const dayText = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("the rules", () => {
  test("the defaults are the times of spec 18, section 6", () => {
    expect(
      Object.fromEntries(KEEPING_RULES.map((r) => [r.id, [r.leastDays, r.defaultDays]])),
    ).toEqual({
      email_log: [1, 30],
      audit_log: [30, 365],
      search_terms: [7, 90],
      consent_records: [30, 365],
    });
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: keeping times`, () => {
    let db: TestDb;
    let n = 0;
    const mail = (site: string, ageDays: number) =>
      db.run(
        `insert into email_log (id, site_id, email_key, to_address, subject, provider, status, attempts, created_at) values (?, ?, 'k', 'a@example.com', 's', 'smtp', 'sent', 1, ?)`,
        [`MAIL${String(++n).padStart(22, "0")}`, site, new Date(NOW - ageDays * DAY)],
      );
    const audit = (site: string, ageDays: number) =>
      db.run(
        `insert into audit_log (id, site_id, actor_type, actor_id, action, detail, created_at) values (?, ?, 'system', 'x', 'test', ?, ?)`,
        [`AUDT${String(++n).padStart(22, "0")}`, site, "{}", new Date(NOW - ageDays * DAY)],
      );
    /** A count for the day `ageDays` days before today (0 is today). */
    const search = (site: string, ageDays: number) =>
      db.run(
        `insert into search_terms (site_id, term, day, searches, no_results) values (?, ?, ?, 1, 0)`,
        [site, `word${++n}`, dayText(NOW - ageDays * DAY)],
      );
    const left = async (table: string, site: string) =>
      Number(
        (await db.runner.all(`select count(*) as "n" from ${table} where site_id = ?`, [site]))[0]![
          "n"
        ],
      );

    beforeEach(async () => {
      db = await open();
      n = 0;
      for (const id of [SITE, SITE2])
        await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
          id,
          T,
          T,
        ]);
    });

    test("with nothing chosen the defaults are in force; an owner may shorten a time, and the choice is kept", async () => {
      const fresh = await loadKeeping(db.runner, SITE);
      expect(fresh.days).toEqual({
        email_log: 30,
        audit_log: 365,
        search_terms: 90,
        consent_records: 365,
      });
      expect(fresh.shortened).toEqual({
        email_log: false,
        audit_log: false,
        search_terms: false,
        consent_records: false,
      });
      expect(fresh.lastRun).toBeNull();
      const saved = await saveKeeping(db.runner, admin, SITE, { email_log: 7, audit_log: "180" });
      expect(saved.ok && saved.keeping.days).toEqual({
        email_log: 7,
        audit_log: 180,
        search_terms: 90,
        consent_records: 365,
      });
      expect(saved.ok && saved.keeping.shortened).toEqual({
        email_log: true,
        audit_log: true,
        search_terms: false,
        consent_records: false,
      });
      // Another site is not touched.
      expect((await loadKeeping(db.runner, SITE2)).days.email_log).toBe(30);
      // Saving the default again, or leaving a kind out, puts it back to the default.
      const back = await saveKeeping(db.runner, admin, SITE, { email_log: 30 });
      expect(back.ok && back.keeping.days).toEqual({
        email_log: 30,
        audit_log: 365,
        search_terms: 90,
        consent_records: 365,
      });
    });

    test.each([
      [
        "a longer time",
        { email_log: 31 },
        "Record of emails sent: choose a number of days from 1 to 30.",
      ],
      [
        "a time that is too short",
        { audit_log: 29 },
        "Audit log: choose a number of days from 30 to 365.",
      ],
      [
        "no days at all",
        { search_terms: 0 },
        "Site search counts: choose a number of days from 7 to 90.",
      ],
      ["a part of a day", { email_log: 1.5 }, "Record of emails sent"],
      ["words", { email_log: "soon" }, "Record of emails sent"],
      ["a negative number", { email_log: -5 }, "Record of emails sent"],
      [
        "something the site does not keep for a time",
        { passwords: 5 },
        "This is not something the site keeps for a time.",
      ],
    ])("%s is refused in plain words and nothing is saved", async (_name, input, words) => {
      const r = await saveKeeping(db.runner, admin, SITE, input);
      expect(!r.ok && r.code).toBe("invalid");
      expect(!r.ok && r.message).toContain(words);
      expect((await loadKeeping(db.runner, SITE)).shortened).toEqual({
        email_log: false,
        audit_log: false,
        search_terms: false,
        consent_records: false,
      });
    });

    test("only people who manage the settings may change the times, and a request that is not an object is refused", async () => {
      const r = await saveKeeping(db.runner, nobody, SITE, { email_log: 7 });
      expect(!r.ok && r.code).toBe("forbidden");
      for (const bad of [null, "x", 5, [1]]) {
        const x = await saveKeeping(db.runner, admin, SITE, bad);
        expect(!x.ok && x.code).toBe("invalid");
      }
    });

    test("a stored time that is longer than the default, or not a number, is ignored", async () => {
      await db.run(
        `insert into settings (site_id, key, value, revision, updated_at) values (?, 'keeping', ?, 1, ?)`,
        [SITE, JSON.stringify({ email_log: 999, audit_log: "soon", search_terms: 3 }), T],
      );
      expect((await loadKeeping(db.runner, SITE)).days).toEqual({
        email_log: 30,
        audit_log: 365,
        search_terms: 90,
        consent_records: 365,
      });
    });

    test("the email record, the audit log and the search counts each lose what is past its time, to the day", async () => {
      // Just inside and just outside each default (a day is kept until it is older than the time).
      await mail(SITE, 29);
      await mail(SITE, 31);
      await audit(SITE, 364);
      await audit(SITE, 366);
      await search(SITE, 89);
      await search(SITE, 90);
      await search(SITE, 0);
      const r = await runKeeping(db.runner, () => NOW);
      expect(r).toEqual({
        sites: 2,
        deleted: { email_log: 1, audit_log: 1, search_terms: 1, consent_records: 0 },
      });
      expect([
        await left("email_log", SITE),
        await left("audit_log", SITE),
        await left("search_terms", SITE),
      ]).toEqual([1, 1, 2]);
    });

    test("each site is cleaned with its own times, and only its own rows", async () => {
      await saveKeeping(db.runner, admin, SITE2, { email_log: 7, audit_log: 60, search_terms: 14 });
      for (const site of [SITE, SITE2]) {
        await mail(site, 10);
        await audit(site, 100);
        await search(site, 20);
      }
      await runKeeping(db.runner, () => NOW);
      // The site with the defaults keeps all three; the one that shortened its times keeps none.
      expect([
        await left("email_log", SITE),
        await left("audit_log", SITE),
        await left("search_terms", SITE),
      ]).toEqual([1, 1, 1]);
      expect([
        await left("email_log", SITE2),
        await left("audit_log", SITE2),
        await left("search_terms", SITE2),
      ]).toEqual([0, 0, 0]);
    });

    test("a shortened time takes effect at the next run, and the run is written down with counts only", async () => {
      await mail(SITE, 20);
      await audit(SITE, 200);
      await runKeeping(db.runner, () => NOW);
      expect(await left("email_log", SITE)).toBe(1);
      await saveKeeping(db.runner, admin, SITE, { email_log: 14, audit_log: 100 });
      const again = await runKeeping(db.runner, () => NOW + 1000);
      expect(again.deleted).toMatchObject({ email_log: 1, audit_log: 1 });
      const view = await loadKeeping(db.runner, SITE);
      expect(view.lastRun).toEqual({
        at: NOW + 1000,
        deleted: { email_log: 1, audit_log: 1, search_terms: 0, consent_records: 0 },
      });
      // Running it again deletes nothing more.
      expect((await runKeeping(db.runner, () => NOW + 2000)).deleted).toEqual({
        email_log: 0,
        audit_log: 0,
        search_terms: 0,
        consent_records: 0,
      });
    });

    test("the separate purges delete exactly what is older than the days they are given", async () => {
      await mail(SITE, 5);
      await mail(SITE, 6);
      await audit(SITE, 5);
      await audit(SITE, 6);
      await search(SITE, 4);
      await search(SITE, 5);
      expect(await purgeEmailLog(db.runner, SITE, 5, () => NOW)).toBe(1);
      expect(await purgeAuditLog(db.runner, SITE, 5, () => NOW)).toBe(1);
      expect(await purgeSearchCounts(db.runner, SITE, 5, () => NOW)).toBe(1);
      for (const age of [364, 366])
        await db.run(
          `insert into consent_records (id, site_id, choice, version, created_at) values (?, ?, 'media', 'media', ?)`,
          [`CONS${String(++n).padStart(22, "0")}`, SITE, new Date(NOW - age * DAY)],
        );
      expect(await purgeConsentRecords(db.runner, SITE, 365, () => NOW)).toBe(1);
      expect([
        await left("email_log", SITE),
        await left("audit_log", SITE),
        await left("search_terms", SITE),
        await left("consent_records", SITE),
      ]).toEqual([1, 1, 1, 1]);
    });
  });
}
