// Site health (spec 07, section 16; AD-70 to AD-75): every check at its limits, hiding, and what comes back.
import { generateKeyPairSync, sign } from "node:crypto";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, type Actor } from "./content.js";
import { saveEmailSettings, type MakeTransport } from "./email.js";
import {
  HIDE_DAYS,
  healthLine,
  hideHealthCheck,
  loadHeartbeat,
  recordHeartbeat,
  runHealthChecks,
  unhideHealthCheck,
  type HealthFacts,
  type HealthReport,
} from "./health.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";
import { runUpdateCheck } from "./updates.js";
import { UPDATE_LIST_PREFIX } from "./update-list.js";

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-11-26T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;
const actorFor = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (c) => caps.includes(c) };
};
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEYS = [publicKey.export({ type: "spki", format: "der" }).toString("base64")];
const signed = (list: unknown) => {
  const body = `${UPDATE_LIST_PREFIX}.${Buffer.from(JSON.stringify(list)).toString("base64url")}`;
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
};

const healthy = (over: Partial<HealthFacts> = {}): HealthFacts => ({
  core: "1.4.3",
  installed: [],
  plugins: [],
  secret: { present: true, length: 48, example: false },
  production: true,
  publicUrl: "https://garden.example",
  certificateDaysLeft: 60,
  diskFreeBytes: 50 * GB,
  diskTotalBytes: 100 * GB,
  admins: [{ name: "Anna", twoFactor: true }],
  lastGoodBackupAt: NOW - 3 * 60 * 60 * 1000,
  ...over,
});
const level = (report: HealthReport, key: string) =>
  [...report.results, ...report.hidden].find((r) => r.key === key)?.level;

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: Site health`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let eve: Actor;
    const secrets = new SiteSecrets("x".repeat(40));
    const accepting: MakeTransport = () => ({ send: async () => undefined });
    const run = (facts: HealthFacts, now = NOW) =>
      runHealthChecks(db.runner, siteId, facts, now, { keys: KEYS });
    const setupEmail = async () => {
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
    };

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async (input) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, input.name, input.email, new Date(NOW), new Date(NOW)],
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
    });

    test("a site with everything in order has nothing amber or red, and the checks that cannot run are grey, not problems (AD-73)", async () => {
      await setupEmail();
      await recordHeartbeat(db.runner, siteId, NOW - 60_000);
      const report = await run(healthy());
      expect(report.summary.red).toBe(0);
      expect(report.summary.amber).toBe(0);
      expect(healthLine(report.summary)).toBe("Healthy");
      // No update list was ever received: these are grey, "could not check".
      for (const key of ["support", "warnings", "update-checks", "updates-waiting"])
        expect(level(report, key)).toBe("grey");
      expect(level(report, "database")).toBe("green");
      // Worst first: nothing red or amber, then grey, then green.
      const rank = { red: 0, amber: 1, grey: 2, green: 3 } as const;
      const ranks = report.results.map((r) => rank[r.level]);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(report.results.every((r) => r.title && r.text)).toBe(true);
    });

    test("the secret: missing, short or an example value is red (AD-71)", async () => {
      for (const secret of [
        { present: false, length: 0, example: false },
        { present: true, length: 20, example: false },
        { present: true, length: 48, example: true },
      ])
        expect(level(await run(healthy({ secret })), "secret")).toBe("red");
      expect(level(await run(healthy()), "secret")).toBe("green");
    });

    test("development mode is red on a public address and fine on a local one", async () => {
      expect(level(await run(healthy({ production: false })), "debug")).toBe("red");
      expect(
        level(
          await run(healthy({ production: false, publicUrl: "http://localhost:3000" })),
          "debug",
        ),
      ).toBe("green");
    });

    test("AD-72 HTTPS: no https is red, the certificate is amber within 14 days, red within 3 or ended, grey when it cannot be read or the address is local", async () => {
      const https = async (over: Partial<HealthFacts>) => level(await run(healthy(over)), "https");
      expect(await https({ publicUrl: "http://garden.example" })).toBe("red");
      expect(await https({ certificateDaysLeft: 60 })).toBe("green");
      expect(await https({ certificateDaysLeft: 15 })).toBe("green");
      expect(await https({ certificateDaysLeft: 14 })).toBe("amber");
      expect(await https({ certificateDaysLeft: 4 })).toBe("amber");
      expect(await https({ certificateDaysLeft: 3 })).toBe("red");
      expect(await https({ certificateDaysLeft: -2 })).toBe("red");
      expect(await https({ certificateDaysLeft: null })).toBe("grey");
      expect(await https({ publicUrl: null })).toBe("grey");
      expect(await https({ publicUrl: "http://localhost:3000" })).toBe("grey");
    });

    test("administrators without two-factor are amber and named", async () => {
      const report = await run(
        healthy({
          admins: [
            { name: "Anna", twoFactor: true },
            { name: "Ben", twoFactor: false },
          ],
        }),
      );
      const check = report.results.find((r) => r.key === "two-factor")!;
      expect(check.level).toBe("amber");
      expect(check.text).toContain("Ben");
      expect(check.text).not.toContain("Anna");
      expect(check.count).toBe(1);
    });

    test("disk space: amber under 10% or 1 GB, red under 2% or 200 MB, grey when unknown", async () => {
      const disk = async (free: number | null, total: number | null) =>
        level(await run(healthy({ diskFreeBytes: free, diskTotalBytes: total })), "disk");
      expect(await disk(50 * GB, 100 * GB)).toBe("green");
      expect(await disk(9 * GB, 100 * GB)).toBe("amber");
      expect(await disk(0.9 * GB, 10 * GB)).toBe("amber");
      expect(await disk(1.9 * GB, 100 * GB)).toBe("red");
      expect(await disk(2 * GB, 100 * GB)).toBe("amber");
      expect(await disk(0.5 * GB, null)).toBe("amber");
      expect(await disk(100 * 1024 * 1024, null)).toBe("red");
      expect(await disk(null, null)).toBe("grey");
    });

    test("the job runner: unknown is grey, fresh is green, silent for 10 minutes is red; the note is kept at most once a minute", async () => {
      expect(level(await run(healthy()), "jobs")).toBe("grey");
      await recordHeartbeat(db.runner, siteId, NOW - 2 * 60_000);
      expect(level(await run(healthy()), "jobs")).toBe("green");
      expect(await loadHeartbeat(db.runner, siteId)).toBe(NOW - 2 * 60_000);
      await recordHeartbeat(db.runner, siteId, NOW - 2 * 60_000 + 30_000);
      expect(await loadHeartbeat(db.runner, siteId)).toBe(NOW - 2 * 60_000);
      // The note is from 2 minutes before NOW: 7 minutes later it is 9 minutes old (fine), 9 minutes later 11 (red).
      expect(level(await run(healthy(), NOW + 7 * 60_000), "jobs")).toBe("green");
      expect(level(await run(healthy(), NOW + 9 * 60_000), "jobs")).toBe("red");
    });

    test("a scheduled post more than 5 minutes late is red; one that is on time is fine", async () => {
      const made = await createDraft(db.runner, anna, siteId, { type: "post", title: "Late" });
      if (!made.ok) throw new Error(made.message);
      const setTime = (ms: number) =>
        db.run(`update "entries" set "status" = 'scheduled', "scheduled_at" = ? where "id" = ?`, [
          new Date(ms),
          made.id,
        ]);
      await setTime(NOW - 3 * 60_000);
      expect(level(await run(healthy()), "scheduled-posts")).toBe("green");
      await setTime(NOW - 6 * 60_000);
      const late = (await run(healthy())).results.find((r) => r.key === "scheduled-posts")!;
      expect(late.level).toBe("red");
      expect(late.count).toBe(1);
    });

    test("email: not set up is amber and says how to fix it; set up is green", async () => {
      const before = (await run(healthy())).results.find((r) => r.key === "email-setup")!;
      expect(before.level).toBe("amber");
      expect(before.fix?.href).toBe("/admin/settings/email");
      await setupEmail();
      const after = await run(healthy());
      expect(level(after, "email-setup")).toBe("green");
      expect(level(after, "email-sending")).toBe("green");
    });

    test("backups: red when the last one failed, amber when none was made or the newest is older than two days", async () => {
      const backups = async (over: Partial<HealthFacts>) =>
        level(await run(healthy(over)), "backups");
      expect(await backups({})).toBe("green");
      expect(await backups({ lastGoodBackupAt: null })).toBe("amber");
      expect(await backups({ lastGoodBackupAt: NOW - 49 * 60 * 60 * 1000 })).toBe("amber");
      expect(await backups({ lastGoodBackupAt: NOW - 47 * 60 * 60 * 1000 })).toBe("green");
      await db.run(
        `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, 'backup_state', ?, 1, ?)`,
        [
          siteId,
          JSON.stringify({ failedAt: NOW - 1000, failure: "No room on the disk." }),
          new Date(NOW),
        ],
      );
      expect(await backups({})).toBe("red");
    });

    test("plugins switched off are amber, named, and counted", async () => {
      const report = await run(
        healthy({
          plugins: [
            { id: "gallery", name: "Gallery", status: "switched_off" },
            { id: "forms", name: "Forms", status: "enabled" },
          ],
        }),
      );
      const check = report.results.find((r) => r.key === "plugins-off")!;
      expect(check.level).toBe("amber");
      expect(check.text).toContain("Gallery");
      expect(check.text).not.toContain("Forms");
      expect(check.count).toBe(1);
    });

    test("updates: a believed list gives the support, warning and update-check results (UP-04, UP-11)", async () => {
      const list = (over: Record<string, unknown> = {}) => ({
        v: 1,
        seq: 1,
        issued: "2026-11-26T08:00:00.000Z",
        core: { "1": "1.4.3" },
        items: [{ key: "gallery", kind: "plugin", latest: "2.1.0", unsafe: ["2.0.0"] }],
        warnings: [],
        ...over,
      });
      const store = (l: unknown, nowMs = NOW) =>
        runUpdateCheck(db.runner, siteId, {
          url: "https://updates.example.com/list",
          keys: KEYS,
          fetch: (async () => new Response(signed(l))) as typeof fetch,
          now: () => nowMs,
          userAgent: "x",
        });
      await store(list());
      let report = await run(healthy({ core: "1.4.3" }));
      expect(level(report, "support")).toBe("green");
      expect(level(report, "update-checks")).toBe("green");
      expect(level(report, "warnings")).toBe("green");
      // A version the list does not name is red.
      report = await run(healthy({ core: "0.9.0" }));
      expect(level(report, "support")).toBe("red");
      // An unsafe plugin that is still on is red; one that is switched off is not.
      const gallery = {
        key: "gallery",
        kind: "plugin" as const,
        name: "Gallery",
        version: "2.0.0",
      };
      expect(
        level(
          await run(
            healthy({
              installed: [gallery],
              plugins: [{ id: "gallery", name: "Gallery", status: "enabled" }],
            }),
          ),
          "warnings",
        ),
      ).toBe("red");
      expect(
        level(
          await run(
            healthy({
              installed: [gallery],
              plugins: [{ id: "gallery", name: "Gallery", status: "disabled" }],
            }),
          ),
          "warnings",
        ),
      ).toBe("green");
      // A security warning that names the core is red, and gone once the core is fixed.
      await store(
        list({
          seq: 2,
          warnings: [
            {
              id: "OKS-1",
              affects: "core",
              versions: "<1.4.3",
              fixed: "1.4.3",
              severity: "critical",
              summary: "A page could be read by someone who may not.",
              link: "https://example.com/a",
            },
          ],
        }),
      );
      expect(level(await run(healthy({ core: "1.4.0" })), "warnings")).toBe("red");
      expect(level(await run(healthy({ core: "1.4.3" })), "warnings")).toBe("green");
      // More than 7 days old: amber.
      expect(level(await run(healthy(), NOW + 8 * DAY), "update-checks")).toBe("amber");
    });

    test("AD-74 an amber result can be hidden, with who and when; it is listed under hidden; a red one cannot be hidden", async () => {
      const facts = healthy({
        admins: [
          { name: "Anna", twoFactor: true },
          { name: "Ben", twoFactor: false },
        ],
      });
      let report = await run(facts);
      expect(
        await hideHealthCheck(db.runner, eve, siteId, report, "two-factor", "Eve", NOW),
      ).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await hideHealthCheck(db.runner, anna, siteId, report, 7, "Anna", NOW)).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(
        await hideHealthCheck(db.runner, anna, siteId, report, "nothing", "Anna", NOW),
      ).toMatchObject({
        ok: false,
        code: "not_found",
      });
      // A red result (the secret) cannot be hidden.
      const bad = await run(healthy({ secret: { present: false, length: 0, example: false } }));
      expect(
        await hideHealthCheck(db.runner, anna, siteId, bad, "secret", "Anna", NOW),
      ).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(
        await hideHealthCheck(db.runner, anna, siteId, report, "two-factor", "Anna", NOW),
      ).toEqual({ ok: true });
      report = await run(facts);
      expect(report.results.some((r) => r.key === "two-factor")).toBe(false);
      expect(report.hidden).toHaveLength(1);
      expect(report.hidden[0]).toMatchObject({
        key: "two-factor",
        hiddenBy: "Anna",
        hiddenAt: NOW,
      });
      // A hidden result is not counted as a problem.
      expect(report.summary.amber).toBe(report.results.filter((r) => r.level === "amber").length);
    });

    test("AD-74 a hidden result comes back when it gets worse, when it turns red, and after 90 days", async () => {
      const two = (n: number) =>
        healthy({
          admins: [
            { name: "Anna", twoFactor: true },
            ...Array.from({ length: n }, (_, i) => ({ name: `P${i}`, twoFactor: false })),
          ],
        });
      let report = await run(two(1));
      await hideHealthCheck(db.runner, anna, siteId, report, "two-factor", "Anna", NOW);
      expect((await run(two(1), NOW + DAY)).hidden).toHaveLength(1);
      // The same number, just under 90 days later: still hidden.
      expect((await run(two(1), NOW + (HIDE_DAYS - 1) * DAY)).hidden).toHaveLength(1);
      // One more person without two-factor: back.
      report = await run(two(2), NOW + DAY);
      expect(report.hidden).toHaveLength(0);
      expect(level(report, "two-factor")).toBe("amber");
      // Fewer is not worse.
      expect((await run(two(1), NOW + DAY)).hidden).toHaveLength(1);
      // After 90 days: back.
      expect((await run(two(1), NOW + HIDE_DAYS * DAY)).hidden).toHaveLength(0);
      // A certificate that was amber and hidden, and then turns red, comes back red.
      const cert = (days: number) => healthy({ certificateDaysLeft: days });
      await hideHealthCheck(db.runner, anna, siteId, await run(cert(10)), "https", "Anna", NOW);
      expect((await run(cert(10))).hidden.map((h) => h.key)).toContain("https");
      const worse = await run(cert(2));
      expect(worse.hidden.map((h) => h.key)).not.toContain("https");
      expect(level(worse, "https")).toBe("red");
    });

    test("a hidden result can be shown again by hand, and only by people who manage the settings", async () => {
      const facts = healthy({ admins: [{ name: "Ben", twoFactor: false }] });
      await hideHealthCheck(db.runner, anna, siteId, await run(facts), "two-factor", "Anna", NOW);
      expect(await unhideHealthCheck(db.runner, eve, siteId, "two-factor")).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await unhideHealthCheck(db.runner, anna, siteId, "nothing")).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(await unhideHealthCheck(db.runner, anna, siteId, "two-factor")).toEqual({ ok: true });
      expect((await run(facts)).hidden).toHaveLength(0);
    });

    test("the line for the dashboard counts red and amber only", () => {
      expect(healthLine({ red: 0, amber: 0, grey: 4, green: 9 })).toBe("Healthy");
      expect(healthLine({ red: 1, amber: 0, grey: 0, green: 3 })).toBe("1 thing needs attention");
      expect(healthLine({ red: 1, amber: 2, grey: 0, green: 3 })).toBe("3 things need attention");
    });
  });
}
