// Filter and action hooks (spec 04, section 7): the value goes from plugin to plugin in a set order; a plugin that fails,
// answers in the wrong shape or changes the value without `content:write` is left out; an action never stops anything.
// On the real sandbox host, with the audit trail in SQLite and in PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxHost } from "./host.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000050";
const ext = (key: string) =>
  `EXT${key
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .padEnd(23, "0")}`.slice(0, 26);
const filter = (body: string) =>
  `export default { hooks: { "content:beforeSave": async (e) => { ${body} } } };`;

interface P {
  code: string;
  priority?: number;
  permissions: string[];
  displayName: string;
}
const PLUGINS: Record<string, P> = {
  second: {
    displayName: "Second",
    priority: 20,
    permissions: ["content:write"],
    code: filter(`return { ...e, meta: { ...e.meta, second: (e.meta.first || 0) + 1 } };`),
  },
  first: {
    displayName: "First",
    priority: 5,
    permissions: ["content:write"],
    code: filter(`return { ...e, title: e.title + "!", meta: { ...e.meta, first: 1 } };`),
  },
  nowrite: {
    displayName: "No Write",
    permissions: ["content:read"],
    code: filter(`return { ...e, title: "hacked" };`),
  },
  crasher: {
    displayName: "Crasher",
    permissions: ["content:write"],
    code: filter(`throw new Error("boom");`),
  },
  notobject: {
    displayName: "Not Object",
    permissions: ["content:write"],
    code: filter(`return 5;`),
  },
  huge: {
    displayName: "Huge",
    permissions: ["content:write"],
    code: filter(`return { ...e, meta: { big: "x".repeat(300000) } };`),
  },
  same: { displayName: "Same", permissions: [], code: filter(`return e;`) },
  reactor: {
    displayName: "Reactor",
    permissions: [],
    code: `export default { hooks: { "content:afterSave": async (e) => { throw new Error("late"); } } };`,
  },
};
const entry = () => ({ id: "e1", title: "T", meta: {} as Record<string, unknown> });

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: filter and action hooks`, () => {
    let db: TestDb;
    const hosts: SandboxHost[] = [];
    const workDir = mkdtempSync(join(tmpdir(), "oks-filters-"));

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

    const hostWith = async (keys: string[]) => {
      const host = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: { get: async () => null, update: async () => null },
        workDir,
        wallMs: 2000,
        maxFailures: 10,
        allowPrivateForTests: true,
        onDeveloperNote: () => undefined,
      });
      await host.listen();
      hosts.push(host);
      for (const key of keys) {
        const p = PLUGINS[key]!;
        host.load(
          {
            id: key,
            version: "1.0.0",
            permissions: p.permissions,
            priority: p.priority,
            displayName: p.displayName,
          } as never,
          p.code,
          ext(key),
        );
      }
      return host;
    };

    test("the value goes through the plugins by priority, not by the order they were installed", async () => {
      const host = await hostWith(["second", "first"]);
      const run = await host.runFilter("content:beforeSave", entry());
      expect(run.applied.map((a) => a.pluginId)).toEqual(["first", "second"]);
      expect(run.value).toEqual({ id: "e1", title: "T!", meta: { first: 1, second: 2 } });
      expect(run.skipped).toEqual([]);
    }, 60_000);

    test("a plugin that changes the value without content:write is left out, and the owner's note says so", async () => {
      const host = await hostWith(["nowrite", "first"]);
      const run = await host.runFilter("content:beforeSave", entry());
      expect(run.applied.map((a) => a.pluginId)).toEqual(["first"]);
      expect((run.value as { title: string }).title).toBe("T!");
      const notes = await host.permissionNotes();
      expect(notes.map((n) => [n.pluginId, n.permission])).toContainEqual([
        "nowrite",
        "content:write",
      ]);
    }, 60_000);

    test("a plugin that crashes, answers with something that is not an object, or answers too much is left out", async () => {
      const host = await hostWith(["crasher", "notobject", "huge", "first"]);
      const run = await host.runFilter("content:beforeSave", entry());
      expect(run.applied.map((a) => a.pluginId)).toEqual(["first"]);
      expect(run.skipped.map((s) => s.pluginId).sort()).toEqual(["crasher", "huge"]);
      expect(run.skipped.find((s) => s.pluginId === "crasher")!.message).toMatch(
        /Crasher could not run/,
      );
    }, 60_000);

    test("an answer that changes nothing is not counted, and a hook the plugin does not have is skipped", async () => {
      const host = await hostWith(["same", "reactor"]);
      const run = await host.runFilter("content:beforeSave", entry());
      expect(run.applied).toEqual([]);
      expect(run.skipped).toEqual([]);
      expect(run.value).toEqual(entry());
    }, 60_000);

    test("an action reaches every plugin and never throws, even when a plugin fails", async () => {
      const host = await hostWith(["reactor", "same"]);
      await expect(host.runAction("content:afterSave", entry())).resolves.toBeUndefined();
    }, 60_000);
  });
}
