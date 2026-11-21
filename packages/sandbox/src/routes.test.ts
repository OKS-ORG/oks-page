// Plugin routes (spec 04, section 9): a plugin answers a request the site hands it. The site checks that the plugin is
// on, was given `routes:public` and declared the route; the answer is turned into one of a few safe shapes.
// On the real sandbox host, in SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxHost } from "./host.js";
import { readPluginFile, makePluginFile } from "./plugin-file.js";
import type { RouteInfo, RouteRequest } from "./types.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000060";
const EXT = "EXT00000000000000000000060";

const CODE = `export default { routes: {
  echo: async (req, ctx) => ({ json: { method: req.method, name: req.data && req.data.name, body: req.body, q: req.query } }),
  made: async () => ({ status: 201, json: { made: true } }),
  words: async () => ({ text: "plain words" }),
  go: async (req) => ({ redirect: req.query.to || "/thanks" }),
  both: async () => ({ json: 1, text: "x" }),
  redirected: async () => ({ status: 302, json: 1 }),
  nothing: async () => 5,
  boom: async () => { throw new Error("secret detail"); },
  slow: async () => { await new Promise((r) => setTimeout(r, 4000)); return { json: 1 }; },
  stored: async (req, ctx) => { await ctx.storage.set("c", "k", { n: req.query.n }); return { json: await ctx.storage.get("c", "k") }; },
  huge: async () => ({ json: { big: "x".repeat(300000) } }),
} };`;

const ROUTES: Record<string, RouteInfo> = {
  echo: { method: "POST" },
  made: { method: "POST" },
  words: { method: "GET" },
  go: { method: "GET" },
  both: { method: "GET" },
  redirected: { method: "GET" },
  nothing: { method: "GET" },
  boom: { method: "GET" },
  slow: { method: "GET" },
  stored: { method: "GET" },
  huge: { method: "GET" },
};

const request = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  method: "GET",
  query: {},
  body: "",
  data: null,
  contentType: "",
  ...over,
});

describe("the plugin file's routes", () => {
  const manifest = (routes: unknown, permissions = ["routes:public"]) => ({
    id: "forms-test",
    version: "1.0.0",
    displayName: "Forms test",
    description: "d",
    author: "a",
    permissions,
    hooks: [],
    blocks: [],
    routes,
  });
  const read = (routes: unknown, permissions?: string[]) =>
    readPluginFile(JSON.stringify(makePluginFile(manifest(routes, permissions) as never, "x")));

  test("a plugin may declare routes when it asks for routes:public", () => {
    const r = read({ send: { method: "POST", maxBytes: 5000, signedIn: false } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.manifest.routes).toEqual({ send: { method: "POST", maxBytes: 5000 } });
  });

  test("routes without the permission, with a bad name, method or size are refused", () => {
    expect(read({ send: { method: "POST" } }, []).ok).toBe(false);
    expect(read({ "Bad Name": { method: "GET" } }).ok).toBe(false);
    expect(read({ send: { method: "DELETE" } }).ok).toBe(false);
    expect(read({ send: { method: "GET", maxBytes: 100_001 } }).ok).toBe(false);
    expect(read({ send: { method: "GET", signedIn: "yes" } }).ok).toBe(false);
    expect(read([]).ok).toBe(false);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: plugin routes`, () => {
    let db: TestDb;
    let host: SandboxHost;
    const workDir = mkdtempSync(join(tmpdir(), "oks-routes-"));

    beforeAll(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      await db.run(
        "insert into extensions (id, site_id, key, kind, version, tier, installed_at) values (?, ?, 'routey', 'plugin', '1.0.0', 'runtime', ?)",
        [EXT, SITE, T],
      );
      host = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: { get: async () => null, update: async () => null },
        workDir,
        wallMs: 2000,
        publishWallMs: 1500,
        maxFailures: 50,
        allowPrivateForTests: true,
        onDeveloperNote: () => undefined,
      });
      await host.listen();
      host.load(
        { id: "routey", version: "1.0.0", permissions: ["routes:public"], routes: ROUTES } as never,
        CODE,
        EXT,
      );
    }, 60_000);

    afterAll(async () => {
      await host?.close();
      await db?.close();
      rmSync(workDir, { recursive: true, force: true });
    });

    test("the plugin sees the request and answers with JSON", async () => {
      const r = await host.runRoute(
        "routey",
        "echo",
        request({ method: "POST", body: "name=Anna", data: { name: "Anna" }, query: { a: "1" } }),
      );
      expect(r).toEqual({
        ok: true,
        reply: {
          status: 200,
          json: { method: "POST", name: "Anna", body: "name=Anna", q: { a: "1" } },
        },
      });
    });

    test("a plugin may choose its status, answer with text, or redirect to a page of the site", async () => {
      expect(await host.runRoute("routey", "made", request({ method: "POST" }))).toEqual({
        ok: true,
        reply: { status: 201, json: { made: true } },
      });
      expect(await host.runRoute("routey", "words", request())).toEqual({
        ok: true,
        reply: { status: 200, text: "plain words" },
      });
      expect(
        await host.runRoute("routey", "go", request({ query: { to: "/thanks?x=1" } })),
      ).toEqual({
        ok: true,
        reply: { status: 303, redirect: "/thanks?x=1" },
      });
    });

    test("a redirect to another site is refused, in every form it can take", async () => {
      for (const to of [
        "https://evil.example/",
        "//evil.example",
        "/\\evil.example",
        "javascript:alert(1)",
        "/a b",
      ]) {
        const r = await host.runRoute("routey", "go", request({ query: { to } }));
        expect(r.ok, to).toBe(false);
      }
    });

    test("an answer of the wrong shape, a redirect status, or a too big answer gives 502", async () => {
      for (const name of ["both", "redirected", "nothing", "huge"]) {
        const r = await host.runRoute("routey", name, request());
        expect(r, name).toMatchObject({ ok: false, status: 502 });
      }
    });

    test("a plugin that throws says nothing about its insides, and a slow one is stopped", async () => {
      const crashed = await host.runRoute("routey", "boom", request());
      expect(crashed).toEqual({
        ok: false,
        status: 502,
        message: "The plugin could not answer this request.",
      });
      expect(JSON.stringify(crashed)).not.toContain("secret detail");
      const slow = await host.runRoute("routey", "slow", request());
      expect(slow).toMatchObject({ ok: false, status: 504 });
    });

    test("an unknown route, the wrong method, a plugin that is off or has no permission is refused", async () => {
      expect(await host.runRoute("routey", "nope", request())).toMatchObject({
        ok: false,
        status: 404,
      });
      expect(await host.runRoute("routey", "echo", request({ method: "GET" }))).toMatchObject({
        ok: false,
        status: 405,
      });
      expect(await host.runRoute("ghost", "echo", request())).toMatchObject({
        ok: false,
        status: 404,
      });
      expect(host.routeInfo("routey", "echo")).toEqual({ method: "POST" });
      host.load(
        { id: "limited", version: "1.0.0", permissions: [], routes: ROUTES } as never,
        CODE,
        EXT,
      );
      expect(host.routeInfo("limited", "words")).toBeNull();
      expect(await host.runRoute("limited", "words", request())).toMatchObject({
        ok: false,
        status: 404,
      });
      host.load(
        {
          id: "switched-off",
          version: "1.0.0",
          permissions: ["routes:public"],
          routes: ROUTES,
        } as never,
        CODE,
        EXT,
      );
      host.disable("switched-off");
      expect(host.routeInfo("switched-off", "words")).toBeNull();
      expect(await host.runRoute("switched-off", "words", request())).toMatchObject({
        ok: false,
        status: 404,
      });
    });

    test("a route may use the plugin's own storage", async () => {
      const r = await host.runRoute("routey", "stored", request({ query: { n: "7" } }));
      expect(r).toEqual({ ok: true, reply: { status: 200, json: { n: "7" } } });
    });

    test("describe lists the routes the code has", async () => {
      const fresh = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: { get: async () => null, update: async () => null },
        workDir,
        wallMs: 2000,
        allowPrivateForTests: true,
      });
      await fresh.listen();
      try {
        fresh.load(
          {
            id: "routey",
            version: "1.0.0",
            permissions: ["routes:public"],
            routes: ROUTES,
          } as never,
          CODE,
          EXT,
        );
        const shape = await fresh.describe("routey");
        expect(shape?.routes.sort()).toEqual(Object.keys(ROUTES).sort());
      } finally {
        await fresh.close();
      }
    });
  });
}
