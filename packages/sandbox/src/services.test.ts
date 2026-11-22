// What a plugin may now do with its own storage and with email (spec 04, section 9; spec 16): list and delete what it
// stored, send an email when it has `email:send`, and answer a route with a small page. On the real sandbox, in SQLite
// and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxHost } from "./host.js";
import type { RouteRequest } from "./types.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000071";
const EXT_A = "EXT0000000000000000000071A";
const EXT_B = "EXT0000000000000000000071B";

const CODE = `export default { routes: {
  fill: async (req, ctx) => { for (const k of ["b", "a", "d", "c"]) await ctx.storage.set("rows", k, { k }); await ctx.storage.set("other", "z", 1); return { json: true }; },
  list: async (req, ctx) => ({ json: await ctx.storage.list(req.query.c || "rows", { limit: Number(req.query.limit) || undefined, order: req.query.order, after: req.query.after }) }),
  del: async (req, ctx) => { await ctx.storage.delete("rows", req.query.k); return { json: await ctx.storage.get("rows", req.query.k) }; },
  mail: async (req, ctx) => ({ json: await ctx.email.send({ to: req.query.to, subject: req.query.subject, text: "body" }) }),
  page: async (req) => ({ status: Number(req.query.status) || 200, page: { title: req.query.title || "Done", text: req.query.text || "All good" } }),
} };`;

const ROUTES = Object.fromEntries(
  ["fill", "list", "del", "mail", "page"].map((n) => [n, { method: "GET" as const }]),
);
const get = (query: Record<string, string> = {}): RouteRequest => ({
  method: "GET",
  query,
  body: "",
  data: null,
  contentType: "",
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: storage lists, email and small pages`, () => {
    let db: TestDb;
    let host: SandboxHost;
    const workDir = mkdtempSync(join(tmpdir(), "oks-services-"));
    const mails: { to: string; subject: string; text: string }[] = [];

    const run = async (plugin: string, route: string, query: Record<string, string> = {}) => {
      const r = await host.runRoute(plugin, route, get(query));
      if (!r.ok) throw new Error(`${r.status} ${r.message}`);
      return r.reply;
    };

    beforeAll(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      for (const [id, key] of [
        [EXT_A, "with-mail"],
        [EXT_B, "no-mail"],
      ] as const)
        await db.run(
          "insert into extensions (id, site_id, key, kind, version, tier, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?)",
          [id, SITE, key, T],
        );
      host = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: { get: async () => null, update: async () => null },
        sendEmail: async (_plugin, mail) => {
          mails.push(mail);
          return { sent: true };
        },
        workDir,
        wallMs: 3000,
        publishWallMs: 3000,
        maxFailures: 100,
        onDeveloperNote: () => undefined,
      });
      await host.listen();
      host.load(
        {
          id: "with-mail",
          version: "1.0.0",
          permissions: ["routes:public", "email:send"],
          routes: ROUTES,
        } as never,
        CODE,
        EXT_A,
      );
      host.load(
        {
          id: "no-mail",
          version: "1.0.0",
          permissions: ["routes:public"],
          routes: ROUTES,
        } as never,
        CODE,
        EXT_B,
      );
    }, 60_000);

    afterAll(async () => {
      await host?.close();
      await db?.close();
      rmSync(workDir, { recursive: true, force: true });
    });

    const keys = (reply: { json?: unknown }) => (reply.json as { key: string }[]).map((r) => r.key);

    test("a plugin lists what it stored: by key, either way, a page at a time, only one collection", async () => {
      await run("with-mail", "fill");
      expect(keys(await run("with-mail", "list"))).toEqual(["a", "b", "c", "d"]);
      expect(keys(await run("with-mail", "list", { order: "desc" }))).toEqual(["d", "c", "b", "a"]);
      expect(keys(await run("with-mail", "list", { limit: "2" }))).toEqual(["a", "b"]);
      expect(keys(await run("with-mail", "list", { after: "b" }))).toEqual(["c", "d"]);
      expect(
        keys(await run("with-mail", "list", { order: "desc", after: "c", limit: "1" })),
      ).toEqual(["b"]);
      expect(keys(await run("with-mail", "list", { c: "other" }))).toEqual(["z"]);
      const first = ((await run("with-mail", "list", { limit: "1" })).json as never)[0] as {
        value: unknown;
        updatedAt: number;
      };
      expect(first.value).toEqual({ k: "a" });
      expect(first.updatedAt).toBeGreaterThan(1_600_000_000_000);
    });

    test("a plugin never sees another plugin's storage, and may delete only its own", async () => {
      expect(keys(await run("no-mail", "list"))).toEqual([]);
      await run("no-mail", "del", { k: "a" });
      expect(keys(await run("with-mail", "list"))).toEqual(["a", "b", "c", "d"]);
      expect((await run("with-mail", "del", { k: "a" })).json).toBeNull();
      expect(keys(await run("with-mail", "list"))).toEqual(["b", "c", "d"]);
    });

    test("email goes out only for a plugin that has email:send, and only for one plain address", async () => {
      const before = mails.length;
      await run("with-mail", "mail", { to: "owner@example.com", subject: "Hello" });
      expect(mails.length).toBe(before + 1);
      expect(mails[before]).toEqual({ to: "owner@example.com", subject: "Hello", text: "body" });
      // no permission: the plugin's call stops with an error and nothing is sent
      const refused = await host.runRoute(
        "no-mail",
        "mail",
        get({ to: "a@example.com", subject: "x" }),
      );
      expect(refused.ok).toBe(false);
      // a line break in the address or subject (the way a header is forged) is refused
      for (const query of [
        { to: "a@example.com\nbcc: x@example.com", subject: "x" },
        { to: "a@example.com", subject: "x\r\nbcc: y@example.com" },
        { to: "a@example.com", subject: "" },
      ])
        expect((await host.runRoute("with-mail", "mail", get(query))).ok).toBe(false);
      expect(mails.length).toBe(before + 1);
    });

    test("a plugin may send at most 60 emails an hour", async () => {
      const before = mails.length;
      let refused = 0;
      for (let i = 0; i < 65; i++) {
        const r = await host.runRoute(
          "with-mail",
          "mail",
          get({ to: "a@example.com", subject: `n${i}` }),
        );
        if (!r.ok) refused++;
      }
      expect(mails.length - before).toBe(59);
      expect(refused).toBe(6);
    }, 60_000);

    test("a route may answer with a small page; a wrong or oversized page is a failure", async () => {
      expect(await run("with-mail", "page")).toEqual({
        status: 200,
        page: { title: "Done", text: "All good" },
      });
      expect(await run("with-mail", "page", { status: "400", title: "Oops" })).toEqual({
        status: 400,
        page: { title: "Oops", text: "All good" },
      });
      expect((await host.runRoute("with-mail", "page", get({ text: "x".repeat(4001) }))).ok).toBe(
        false,
      );
      expect((await host.runRoute("with-mail", "page", get({ title: "t".repeat(201) }))).ok).toBe(
        false,
      );
    });
  });
}
