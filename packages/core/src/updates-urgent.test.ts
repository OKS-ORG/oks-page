// Update checks, part 2 (spec 14, sections 4 to 6): the urgent list every hour, the red notice for the core, the email that is sent once.
import { generateKeyPairSync, sign } from "node:crypto";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  EMAIL_JOB,
  emailJobHandler,
  saveEmailSettings,
  type MakeTransport,
  type OutgoingEmail,
} from "./email.js";
import { drainJobs } from "./jobs.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";
import {
  loadUpdateAlerts,
  loadUpdateState,
  loadUpdateView,
  notifyCoreWarnings,
  runUpdateCheck,
  runUrgentCheck,
  saveUpdateChecksOn,
  urgentCheckDue,
} from "./updates.js";
import { UPDATE_LIST_PREFIX } from "./update-list.js";

const at = (iso: string) => Date.parse(iso);
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
const warning = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  affects: "core",
  versions: "<1.4.3",
  fixed: "1.4.3",
  severity: "critical",
  summary: `The problem ${id}.`,
  link: `https://example.com/advisories/${id}`,
  ...over,
});
const main = (over: Record<string, unknown> = {}) => ({
  v: 1,
  seq: 10,
  issued: "2026-11-26T08:00:00.000Z",
  core: { "1": "1.4.3" },
  items: [],
  warnings: [],
  ...over,
});
// The urgent list is the same format with only warnings.
const urgent = (seq: number, warnings: unknown[]) => ({
  v: 1,
  seq,
  issued: "2026-11-26T08:30:00.000Z",
  core: {},
  items: [],
  warnings,
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: update checks, part 2`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let clock = at("2026-11-26T09:00:00Z");
    const secrets = new SiteSecrets("x".repeat(40));
    let sent: OutgoingEmail[] = [];
    const accepting: MakeTransport = () => ({
      send: async (email) => {
        sent.push(email);
      },
    });
    const answer = (token: string): typeof fetch =>
      (async () => new Response(token)) as typeof fetch;
    const lookMain = (list: unknown) =>
      runUpdateCheck(db.runner, siteId, {
        url: "https://updates.example.com/list",
        keys: KEYS,
        fetch: answer(signed(list)),
        now: () => clock,
        userAgent: "x",
      });
    const lookUrgent = (list: unknown) =>
      runUrgentCheck(db.runner, siteId, {
        url: "https://updates.example.com/urgent",
        keys: KEYS,
        fetch: answer(signed(list)),
        now: () => clock,
        userAgent: "x",
      });
    const alerts = (core: string) => loadUpdateAlerts(db.runner, siteId, core, { keys: KEYS });
    const notify = (core: string) =>
      notifyCoreWarnings(
        db.runner,
        siteId,
        secrets,
        {
          core,
          siteName: "Anna's Garden",
          link: "https://garden.example/admin/tools/updates",
          keys: KEYS,
        },
        () => clock,
      );
    const drain = () =>
      drainJobs(
        db.runner,
        {
          [EMAIL_JOB]: emailJobHandler(db.runner, secrets, {
            makeTransport: accepting,
            now: () => clock,
          }),
        },
        { now: () => clock },
      );

    beforeEach(async () => {
      db = await open();
      clock = at("2026-11-26T09:00:00Z");
      sent = [];
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
    });
    afterEach(async () => {
      await db.close();
    });

    test("the urgent list is kept apart: its own number, its own note, and the main list is not touched", async () => {
      await lookMain(main({ seq: 10 }));
      expect(await lookUrgent(urgent(50, []))).toEqual({ status: "new", seq: 50 });
      // A lower number is refused for the urgent list only; the main list's number does not matter to it.
      expect(await lookUrgent(urgent(49, []))).toMatchObject({ status: "refused" });
      expect(await lookUrgent(urgent(51, []))).toEqual({ status: "new", seq: 51 });
      const state = await loadUpdateState(db.runner, siteId);
      expect(state.failure).toBe("");
      expect(state.urgentFailure).toBe("");
      expect(state.urgentCheckedAt).toBe(clock);
      // A failed look at the urgent list does not mark the main list as failing.
      const down = (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      await runUrgentCheck(db.runner, siteId, {
        url: "https://updates.example.com/urgent",
        keys: KEYS,
        fetch: down,
        now: () => clock,
        userAgent: "x",
      });
      const after = await loadUpdateState(db.runner, siteId);
      expect(after.urgentFailure).not.toBe("");
      expect(after.failure).toBe("");
      expect(after.token).toBe(state.token);
    });

    test("a look at the main list does not lose what the urgent look noted, and the other way round", async () => {
      await lookUrgent(urgent(5, [warning("A-1")]));
      await lookMain(main({ seq: 2 }));
      const state = await loadUpdateState(db.runner, siteId);
      expect(state.urgentToken).not.toBeNull();
      expect(state.token).not.toBeNull();
    });

    test("an urgent look is due every hour; a main look every day", async () => {
      expect(urgentCheckDue(await loadUpdateState(db.runner, siteId), clock)).toBe(true);
      await lookUrgent(urgent(1, []));
      const state = await loadUpdateState(db.runner, siteId);
      expect(urgentCheckDue(state, clock + 30 * 60 * 1000)).toBe(false);
      expect(urgentCheckDue(state, clock + 61 * 60 * 1000)).toBe(true);
    });

    test("the urgent list's warnings join the main list's, once each, and the notice names the core only", async () => {
      await lookMain(main({ warnings: [warning("A-1"), warning("A-2", { affects: "gallery" })] }));
      await lookUrgent(urgent(3, [warning("A-1", { summary: "Newer words." }), warning("A-3")]));
      const a = await alerts("1.4.0");
      expect(a.coreWarnings.map((w) => w.id).sort()).toEqual(["A-1", "A-3"]);
      expect(a.coreWarnings.find((w) => w.id === "A-1")!.summary).toBe("Newer words.");
      // The warning about a plugin the site does not run is not a core warning.
      expect(a.coreWarnings.some((w) => w.id === "A-2")).toBe(false);
      // The Updates screen sees the same ones.
      const view = await loadUpdateView(
        db.runner,
        siteId,
        { core: "1.4.0", items: [] },
        { keys: KEYS },
      );
      expect(view.comparison!.warnings.map((w) => w.id).sort()).toEqual(["A-1", "A-3"]);
    });

    test("an urgent list alone gives a notice even before the main list has ever come", async () => {
      await lookUrgent(urgent(1, [warning("A-9")]));
      expect((await alerts("1.4.0")).coreWarnings.map((w) => w.id)).toEqual(["A-9"]);
      // The core already runs the fixed version: nothing to say.
      expect((await alerts("1.4.3")).coreWarnings).toEqual([]);
    });

    test("a version the list no longer names gets the out-of-support notice, with the newest version to move to", async () => {
      await lookMain(main({ core: { "2": "2.0.1", "3": "3.1.0" } }));
      expect((await alerts("1.9.0")).unsupportedLatest).toBe("3.1.0");
      expect((await alerts("2.0.0")).unsupportedLatest).toBeNull();
      expect((await alerts("3.0.0")).unsupportedLatest).toBeNull();
    });

    test("no notice while the checks are off, and none without a believed list", async () => {
      expect(await alerts("1.4.0")).toEqual({ coreWarnings: [], unsupportedLatest: null });
      await lookUrgent(urgent(1, [warning("A-1")]));
      expect((await alerts("1.4.0")).coreWarnings).toHaveLength(1);
      await saveUpdateChecksOn(db.runner, anna, siteId, false);
      expect(await alerts("1.4.0")).toEqual({ coreWarnings: [], unsupportedLatest: null });
    });

    test("a list signed by someone else gives no notice: nobody can make a site cry wolf", async () => {
      const stranger = generateKeyPairSync("ed25519");
      const body = `${UPDATE_LIST_PREFIX}.${Buffer.from(JSON.stringify(urgent(1, [warning("X-1")]))).toString("base64url")}`;
      const forged = `${body}.${sign(null, Buffer.from(body), stranger.privateKey).toString("base64url")}`;
      const result = await runUrgentCheck(db.runner, siteId, {
        url: "https://updates.example.com/urgent",
        keys: KEYS,
        fetch: answer(forged),
        now: () => clock,
        userAgent: "x",
      });
      expect(result).toMatchObject({ status: "refused" });
      expect((await alerts("1.4.0")).coreWarnings).toEqual([]);
    });

    test("the administrators get one email for each high or critical core warning, never twice, and none for a medium one", async () => {
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
      await lookUrgent(
        urgent(1, [
          warning("A-1"),
          warning("A-2", { severity: "medium" }),
          warning("A-3", { severity: "high" }),
        ]),
      );
      expect(await notify("1.4.0")).toBe(2);
      await drain();
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({ to: "anna@garden.test" });
      expect(sent.map((e) => e.subject)).toEqual([
        "Security warning for Anna's Garden: update needed",
        "Security warning for Anna's Garden: update needed",
      ]);
      const text = sent.map((e) => e.text).join("\n");
      expect(text).toContain("The problem A-1.");
      expect(text).toContain("1.4.3");
      expect(text).toContain("https://garden.example/admin/tools/updates");
      expect(text).toContain("https://example.com/advisories/A-3");
      expect(text).not.toContain("A-2");
      // Again, and after a day: nothing more for these. A new warning is sent once.
      expect(await notify("1.4.0")).toBe(0);
      clock += 25 * 60 * 60 * 1000;
      expect(await notify("1.4.0")).toBe(0);
      await lookUrgent(
        urgent(2, [warning("A-1"), warning("A-3", { severity: "high" }), warning("A-4")]),
      );
      expect(await notify("1.4.0")).toBe(1);
      // The notice still names every warning, also the medium one.
      expect((await alerts("1.4.0")).coreWarnings.map((w) => w.id).sort()).toEqual([
        "A-1",
        "A-3",
        "A-4",
      ]);
    });

    test("with email not set up nothing is queued, and the warning is still remembered, so the site is not flooded later", async () => {
      await lookUrgent(urgent(1, [warning("A-1")]));
      expect(await notify("1.4.0")).toBe(0);
      expect((await loadUpdateState(db.runner, siteId)).warned).toEqual(["A-1"]);
    });
  });
}
