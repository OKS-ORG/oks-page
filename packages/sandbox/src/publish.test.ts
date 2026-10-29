// PL-40: a `content:beforePublish` check that fails or times out does not block publishing, and the owner is told. Only an
// explicit refusal from a plugin that worked blocks (spec 04, sections 5.3 and 7). On the real sandbox host, with the
// audit trail in SQLite and in PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxHost } from "./host.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000040";
const ext = (key: string) =>
  `EXT${key
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .padEnd(23, "0")}`.slice(0, 26);
const hook = (body: string) =>
  `export default { hooks: { "content:beforePublish": async (e) => { ${body} } } };`;
const PLUGINS: Record<string, { code: string; priority?: number; displayName?: string }> = {
  "needs-image": {
    displayName: "Image Check",
    priority: 20,
    code: hook(`return e.hasImage ? {} : { refuse: "Add a featured image first" };`),
  },
  "needs-title": {
    displayName: "Title Check",
    priority: 5,
    code: hook(`return e.title ? {} : { refuse: "Write a title first" };`),
  },
  crasher: {
    displayName: "Crasher",
    priority: 1,
    code: hook(`throw new Error("boom");`),
  },
  sleeper: { displayName: "Sleeper", code: hook(`for (;;) {}`) },
  weird: { displayName: "Weird", code: hook(`return { refuse: 42 };`) },
  fine: { displayName: "Fine", code: hook(`return {};`) },
  quiet: {
    displayName: "Quiet",
    code: `export default { hooks: { "content:afterSave": async (e) => e } };`,
  },
};
const entry = (o: Record<string, unknown> = {}) => ({ id: "e1", title: "T", hasImage: true, ...o });

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the before-publish check (PL-40)`, () => {
    let db: TestDb;
    const hosts: SandboxHost[] = [];
    const workDir = mkdtempSync(join(tmpdir(), "oks-publish-"));

    beforeAll(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      for (const key of Object.keys(PLUGINS))
        await db.run(
          "insert into extensions (id, site_id, key, kind, version, tier, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?)",
          [ext(key), SITE, key, T],
        );
    }, 60_000);

    afterAll(async () => {
      for (const h of hosts) await h.close();
      await db?.close();
    });

    /** A host with only these plugins installed, in this order. */
    const hostWith = async (keys: string[], maxFailures = 10) => {
      const host = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: { get: async () => null, update: async () => null },
        workDir,
        wallMs: 2000,
        publishWallMs: 400,
        maxFailures,
        allowPrivateForTests: true,
      });
      await host.listen();
      hosts.push(host);
      for (const key of keys) {
        const p = PLUGINS[key]!;
        host.load(
          {
            id: key,
            version: "1.0.0",
            permissions: [],
            priority: p.priority,
            displayName: p.displayName,
          } as never,
          p.code,
          ext(key),
        );
      }
      return host;
    };
    const audit = async (action: string) =>
      (
        await db.run(
          `select actor_id, detail from audit_log where actor_type = 'plugin' and action = ?`,
          [action],
        )
      ).map((r) => ({
        plugin: String(r["actor_id"]),
        detail:
          typeof r["detail"] === "string"
            ? (JSON.parse(r["detail"]) as Record<string, unknown>)
            : (r["detail"] as Record<string, unknown>),
      }));

    test("PL-40 an explicit refusal from a plugin that worked blocks publishing, with its message for the author", async () => {
      const host = await hostWith(["needs-image", "fine"]);
      const r = await host.beforePublish(entry({ hasImage: false }));
      expect(r.allowed).toBe(false);
      expect(r.refusal).toEqual({ pluginId: "needs-image", message: "Add a featured image first" });
      expect((await audit("publish.refused")).some((a) => a.plugin === "needs-image")).toBe(true);
    }, 30_000);

    test("PL-40 when every plugin is happy, publishing goes ahead and nothing is skipped", async () => {
      const host = await hostWith(["needs-image", "fine", "quiet"]);
      const r = await host.beforePublish(entry());
      expect(r).toEqual({ allowed: true, skipped: [] });
    }, 30_000);

    test("PL-40 a plugin with no before-publish hook is skipped quietly: no note for the owner", async () => {
      const host = await hostWith(["quiet"]);
      const r = await host.beforePublish(entry());
      expect(r).toEqual({ allowed: true, skipped: [] });
      expect((await host.publishCheckNotes()).some((n) => n.pluginId === "quiet")).toBe(false);
    }, 30_000);

    test("PL-40 a check that crashes does not block publishing, and the owner is told", async () => {
      const host = await hostWith(["crasher", "fine"]);
      const r = await host.beforePublish(entry());
      expect(r.allowed).toBe(true);
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped[0]).toMatchObject({ pluginId: "crasher", why: "failed" });
      expect(r.skipped[0]!.message).toMatch(/Crasher could not check this/);
      const rows = (await audit("publish.check_failed")).filter((a) => a.plugin === "crasher");
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.detail["entry"]).toBe("e1");
    }, 30_000);

    test("PL-40 a check that takes too long is stopped, does not block publishing, and the owner is told", async () => {
      const host = await hostWith(["sleeper"]);
      const started = Date.now();
      const r = await host.beforePublish(entry());
      expect(Date.now() - started).toBeLessThan(3000);
      expect(r.allowed).toBe(true);
      expect(r.skipped[0]).toMatchObject({ pluginId: "sleeper", why: "timeout" });
      expect(r.skipped[0]!.message).toMatch(/took too long/);
      expect(host.isRunning("sleeper")).toBe(false);
    }, 30_000);

    test("PL-40 an answer of the wrong shape counts as a check that could not run, not as a refusal", async () => {
      const host = await hostWith(["weird"]);
      const r = await host.beforePublish(entry());
      expect(r.allowed).toBe(true);
      expect(r.skipped[0]).toMatchObject({ pluginId: "weird", why: "failed" });
    }, 30_000);

    test("PL-40 a plugin that could not check does not hide another plugin's refusal", async () => {
      const host = await hostWith(["crasher", "needs-image"]);
      const r = await host.beforePublish(entry({ hasImage: false }));
      expect(r.allowed).toBe(false);
      expect(r.refusal?.pluginId).toBe("needs-image");
      expect(r.skipped.map((s) => s.pluginId)).toEqual(["crasher"]);
    }, 30_000);

    test("PL-40 checks run by priority: the lower number is asked first, and the first refusal stops the rest", async () => {
      const host = await hostWith(["needs-image", "needs-title"]);
      const r = await host.beforePublish(entry({ title: "", hasImage: false }));
      expect(r.refusal).toEqual({ pluginId: "needs-title", message: "Write a title first" });
    }, 30_000);

    test("PL-40 the owner gets one note for each plugin, however often it could not check, and it survives a restart", async () => {
      const first = await hostWith(["crasher"]);
      for (let i = 0; i < 3; i++) await first.beforePublish(entry({ id: `p${i}` }));
      const before = (await first.publishCheckNotes()).filter((n) => n.pluginId === "crasher");
      expect(before).toHaveLength(1);
      expect(before[0]!.count).toBeGreaterThanOrEqual(3);
      expect(before[0]!.message).toMatch(
        /Crasher could not check posts before they were published/,
      );
      expect(before[0]!.firstAt).toBeLessThanOrEqual(before[0]!.lastAt);
      const restarted = await hostWith(["crasher"]);
      const after = (await restarted.publishCheckNotes()).filter((n) => n.pluginId === "crasher");
      expect(after).toHaveLength(1);
      expect(after[0]!.count).toBe(before[0]!.count);
    }, 30_000);

    test("PL-40 failures still count: three in a minute switch the plugin off, and then it is no longer asked", async () => {
      const host = await hostWith(["crasher", "needs-image"], 3);
      for (let i = 0; i < 3; i++) await host.beforePublish(entry());
      expect(host.status("crasher")).toBe("switched_off");
      const r = await host.beforePublish(entry());
      expect(r).toEqual({ allowed: true, skipped: [] });
    }, 30_000);
  });
}
