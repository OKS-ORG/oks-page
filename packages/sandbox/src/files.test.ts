// The files visitors send to a plugin (spec 16, section 6): what a manifest may say about uploads, and how a plugin attaches
// the files it received to one of its stored items. A plugin can attach only its own files that were just received, only
// with the permission, and the files go when the item goes. On the real sandbox, in SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxHost } from "./host.js";
import { makePluginFile, readPluginFile, readRoutes } from "./plugin-file.js";
import type { RouteRequest } from "./types.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000111";
const EXT_A = "EXT00000000000000000000A11";
const EXT_B = "EXT00000000000000000000B11";
const EXT_N = "EXT00000000000000000000C11";
const fid = (n: number) => `FILE${String(n).padStart(22, "0")}`;

describe("what a manifest may say about uploads", () => {
  const ok = { send: { method: "POST", uploads: { files: 3, maxFileBytes: 10 * 1024 * 1024 } } };

  test("a POST route may take up to 3 files of up to 10 MB", () => {
    expect(readRoutes(ok)).toEqual(ok);
  });

  test.each([
    ["a GET route", { send: { method: "GET", uploads: { files: 1, maxFileBytes: 100 } } }],
    ["no files", { send: { method: "POST", uploads: { files: 0, maxFileBytes: 100 } } }],
    ["4 files", { send: { method: "POST", uploads: { files: 4, maxFileBytes: 100 } } }],
    [
      "a size over 10 MB",
      { send: { method: "POST", uploads: { files: 1, maxFileBytes: 10 * 1024 * 1024 + 1 } } },
    ],
    [
      "a size that is not a whole number",
      { send: { method: "POST", uploads: { files: 1, maxFileBytes: 1.5 } } },
    ],
    ["uploads that are not an object", { send: { method: "POST", uploads: true } }],
  ])("%s is refused", (_name, routes) => {
    expect(typeof readRoutes(routes)).toBe("string");
  });

  test("a plugin file whose route takes files must ask for files:private", () => {
    const manifest = {
      id: "files-demo",
      version: "1.0.0",
      displayName: "Files demo",
      description: "d",
      author: "a",
      permissions: ["routes:public"],
      hooks: [],
      blocks: [],
      routes: ok,
    };
    const without = readPluginFile(
      JSON.stringify(makePluginFile(manifest as never, "export default {};")),
    );
    expect(without.ok).toBe(false);
    expect(!without.ok && without.message).toContain("files:private");
    const withIt = readPluginFile(
      JSON.stringify(
        makePluginFile(
          { ...manifest, permissions: ["routes:public", "files:private"] } as never,
          "export default {};",
        ),
      ),
    );
    expect(withIt.ok).toBe(true);
  });
});

const CODE = `export default { routes: {
  attach: async (req, ctx) => ({ json: await ctx.files.attach(req.query.ids.split(","), "c", "k") }),
  put: async (req, ctx) => { await ctx.storage.set("c", "k", { n: 1 }); return { json: true }; },
  del: async (req, ctx) => { await ctx.storage.delete("c", "k"); return { json: true }; },
} };`;
const ROUTES = Object.fromEntries(
  ["attach", "put", "del"].map((n) => [n, { method: "GET" as const }]),
);
const get = (query: Record<string, string> = {}): RouteRequest => ({
  method: "GET",
  query,
  body: "",
  data: null,
  contentType: "",
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: attaching files to a stored item`, () => {
    let db: TestDb;
    let host: SandboxHost;
    const workDir = mkdtempSync(join(tmpdir(), "oks-files-"));

    const run = async (plugin: string, route: string, query: Record<string, string> = {}) =>
      host.runRoute(plugin, route, get(query));
    const rows = async () =>
      (
        await db.runner.all(
          `select "id", "extension_id", "status", "collection", "key" from extension_files order by "id"`,
        )
      ).map((r) => [
        String(r["id"]),
        String(r["extension_id"]).slice(-3),
        String(r["status"]),
        r["collection"] === null ? null : `${String(r["collection"])}/${String(r["key"])}`,
      ]);
    const addFile = (n: number, ext: string, status: string, c: string | null, k: string | null) =>
      db.run(
        `insert into extension_files (id, extension_id, name, mime, size_bytes, sha256, status, collection, key, data, created_at) values (?, ?, 'a.png', 'image/png', 4, 'x', ?, ?, ?, ?, ?)`,
        [fid(n), ext, status, c, k, Buffer.from([0, 255, 1, 2]), T],
      );

    beforeAll(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      for (const [id, key] of [
        [EXT_A, "with-files"],
        [EXT_B, "other"],
        [EXT_N, "no-permission"],
      ] as const)
        await db.run(
          "insert into extensions (id, site_id, key, kind, version, tier, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?)",
          [id, SITE, key, T],
        );
      host = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: { get: async () => null, update: async () => null },
        workDir,
        wallMs: 3000,
        publishWallMs: 3000,
        maxFailures: 100,
        onDeveloperNote: () => undefined,
      });
      await host.listen();
      for (const [id, ext, permissions] of [
        ["with-files", EXT_A, ["routes:public", "files:private"]],
        ["other", EXT_B, ["routes:public", "files:private"]],
        ["no-permission", EXT_N, ["routes:public"]],
      ] as const)
        host.load(
          { id, version: "1.0.0", permissions: [...permissions], routes: ROUTES },
          CODE,
          ext,
        );
    });

    afterAll(async () => {
      await host.close();
      await db.close();
      rmSync(workDir, { recursive: true, force: true });
    });

    test("a plugin attaches only its own files that were just received", async () => {
      await addFile(1, EXT_A, "pending", null, null);
      await addFile(2, EXT_A, "pending", null, null);
      await addFile(3, EXT_B, "pending", null, null);
      await addFile(4, EXT_A, "kept", "c2", "k2");
      // Its own pending file is attached; another plugin's file and a file that is kept already are not touched.
      const r = await run("with-files", "attach", {
        ids: [fid(1), fid(3), fid(4), "not-an-id"].join(","),
      });
      expect(r.ok && r.reply.json).toBe(1);
      expect(await rows()).toEqual([
        [fid(1), "A11", "kept", "c/k"],
        [fid(2), "A11", "pending", null],
        [fid(3), "B11", "pending", null],
        [fid(4), "A11", "kept", "c2/k2"],
      ]);
      // Again: nothing more to attach.
      const again = await run("with-files", "attach", { ids: fid(1) });
      expect(again.ok && again.reply.json).toBe(0);
    });

    test("deleting the item deletes the files kept with it, and nothing else", async () => {
      await run("with-files", "put");
      await run("with-files", "del");
      expect(await rows()).toEqual([
        [fid(2), "A11", "pending", null],
        [fid(3), "B11", "pending", null],
        [fid(4), "A11", "kept", "c2/k2"],
      ]);
    });

    test("without the permission the plugin cannot attach, and the files stay as they were", async () => {
      await addFile(5, EXT_N, "pending", null, null);
      const r = await run("no-permission", "attach", { ids: fid(5) });
      expect(r.ok).toBe(false);
      expect((await rows()).find((x) => x[0] === fid(5))).toEqual([fid(5), "C11", "pending", null]);
    });

    test("the host says whether a permission was approved", () => {
      expect(host.allowed("with-files", "files:private")).toBe(true);
      expect(host.allowed("no-permission", "files:private")).toBe(false);
      expect(host.allowed("nobody", "files:private")).toBe(false);
      expect(host.extensionOf("with-files")).toBe(EXT_A);
      expect(host.extensionOf("nobody")).toBeNull();
    });

    test("removing the plugin removes all its files", async () => {
      await db.run(`delete from extensions where id = ?`, [EXT_A]);
      expect((await rows()).map((r) => r[1])).toEqual(["B11", "C11"]);
    });
  });
}
