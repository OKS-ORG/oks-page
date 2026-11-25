// The agency dashboard (spec 11, section 6; AG-01 to AG-15, AG-83), on SQLite and PostgreSQL, against real HTTP servers: the
// licence limits, adding a site with its code, checking many sites at once with one of them down, and the plain words for what
// can go wrong (a wrong key, a clock that is off, a redirect, a site that cannot do something yet).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addAgencySite,
  agencySiteLimit,
  callSite,
  checkAgencySites,
  checkSiteUrl,
  fetchSiteReport,
  listAgencySites,
  removeAgencySite,
  type AgencyContext,
} from "./agency.js";
import {
  BODY_MAX_BYTES,
  connectionCode,
  connectorReport,
  connectorStatus,
  NonceStore,
  verifyRequest,
} from "./connector.js";
import type { Actor } from "./content.js";
import type { LicencePayload } from "./licence.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";

const NOW = new Date("2026-11-26T12:00:00Z");
const secretOf = (n: number) => Buffer.alloc(32, n).toString("base64url");
const licence = (over: Partial<LicencePayload> = {}): LicencePayload => ({
  v: 1,
  id: newId(),
  kind: "normal",
  covers: ["agency"],
  sites: 5,
  updatesUntil: null,
  maxMajor: null,
  issued: "2026-01-01",
  ...over,
});

describe("what the Agency keys allow", () => {
  test("the sites add up over the Agency keys that still work, and nothing else counts", () => {
    expect(
      agencySiteLimit([licence({ sites: 5 }), licence({ sites: 10 })], "agency.test", NOW),
    ).toBe(15);
    // A key for every plug-in and theme does not unlock the agency's tools.
    expect(agencySiteLimit([licence({ covers: ["*"], sites: 50 })], "agency.test", NOW)).toBe(0);
    // An ended trial does not count; an ended yearly key still lets the tools run (it only stops updates).
    expect(
      agencySiteLimit(
        [licence({ kind: "trial", updatesUntil: "2026-01-02", sites: 3 })],
        "agency.test",
        NOW,
      ),
    ).toBe(0);
    expect(
      agencySiteLimit([licence({ updatesUntil: "2026-01-02", sites: 4 })], "agency.test", NOW),
    ).toBe(4);
    expect(agencySiteLimit([], "agency.test", NOW)).toBe(0);
  });
});

describe("the address of a client site", () => {
  test("https is accepted; http only on this machine; no password; nothing private", () => {
    expect(checkSiteUrl("https://client.example/")).toEqual({
      ok: true,
      url: "https://client.example",
    });
    expect(checkSiteUrl("https://client.example/blog/?x=1#y")).toEqual({
      ok: true,
      url: "https://client.example/blog",
    });
    expect(checkSiteUrl("http://127.0.0.1:3000")).toEqual({
      ok: true,
      url: "http://127.0.0.1:3000",
    });
    expect(checkSiteUrl("http://localhost:3000").ok).toBe(true);
    for (const bad of [
      "http://client.example",
      "https://user:pass@client.example",
      "ftp://client.example",
      "https://10.0.0.5",
      "https://192.168.1.1",
      "https://172.20.0.1",
      "https://169.254.169.254",
      "not an address",
      "",
    ])
      expect(checkSiteUrl(bad).ok, bad).toBe(false);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the dashboard`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let editor: Actor;
    let server: Server;
    let base = "";
    const secrets = new SiteSecrets("s".repeat(40));
    /** The virtual client sites: path prefix /s<N>, with the keys they accept and how they behave. */
    const farm = new Map<
      number,
      {
        keys: { id: string; secret: string }[];
        nonces: NonceStore;
        mode: "ok" | "hang" | "redirect" | "broken";
      }
    >();
    let offset = 0; // how far the dashboard's clock is from the sites'
    const ctx = (over: Partial<AgencyContext> = {}): AgencyContext => ({
      fetch: globalThis.fetch,
      now: () => Date.now() + offset,
      timeoutMs: 1500,
      agency: { active: true, limit: 100 },
      ...over,
    });
    const site = (n: number, mode: "ok" | "hang" | "redirect" | "broken" = "ok") => {
      farm.set(n, {
        keys: [{ id: `key-${n}`, secret: secretOf(n) }],
        nonces: new NonceStore(),
        mode,
      });
      return connectionCode(`${base}/s${n}`, `key-${n}`, secretOf(n));
    };

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async (input) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, input.name, input.email, NOW, NOW],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Agency",
          admin: { name: "Anna", email: "anna@agency.test", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      const caps = (role: string) => DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
      anna = { userId: setup.userId, can: (c) => caps("administrator").includes(c) };
      editor = { userId: setup.userId, can: (c) => caps("editor").includes(c) };
      farm.clear();
      offset = 0;
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
          const m = /^\/s(\d+)(\/api\/oks\/v1\/([a-z]+))(\?.*)?$/.exec(req.url ?? "");
          const mine = m ? farm.get(Number(m[1])) : undefined;
          const send = (status: number, body: unknown) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
          };
          if (!m || !mine) return send(404, { ok: false, code: "off" });
          if (mine.mode === "hang") return; // never answers
          if (mine.mode === "redirect") {
            res.writeHead(302, { location: "https://elsewhere.example/" });
            return res.end();
          }
          if (mine.mode === "broken") return send(500, { ok: false, message: "The site broke." });
          const verified = verifyRequest({
            method: req.method ?? "GET",
            target: req.url ?? "",
            headers: (n) => (req.headers[n] as string | undefined) ?? null,
            body: Buffer.concat(chunks),
            keys: mine.keys,
            nonces: mine.nonces,
            now: Date.now(),
          });
          if (!verified.ok)
            return send(verified.status, {
              ok: false,
              code: verified.code,
              message: verified.message,
            });
          const action = m[3];
          if (action === "status")
            return send(200, {
              ok: true,
              ...(await connectorStatus(
                db.runner,
                siteId,
                {
                  version: `1.0.${m[1]}`,
                  twoFactor: { on: 1, total: 1 },
                  emailWorks: true,
                  privacyPage: false,
                  diskFreeBytes: 1e9,
                },
                Date.now(),
              )),
            });
          if (action === "report")
            return send(200, {
              ok: true,
              ...(await connectorReport(db.runner, siteId, Date.now(), 30)),
            });
          return send(501, {
            ok: false,
            code: "not_available",
            message: "Remote backups are not built yet.",
          });
        });
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await db.close();
    });

    describe("connecting a site", () => {
      test("a site is connected with its code; only the sealed key is kept (AG-12)", async () => {
        const code = site(1);
        const r = await addAgencySite(
          db.runner,
          anna,
          siteId,
          secrets,
          { code, name: "  Weber Garden " },
          ctx(),
        );
        if (!r.ok) throw new Error(r.message);
        expect(r.site).toMatchObject({ name: "Weber Garden", url: `${base}/s1` });
        expect(r.site.last).toMatchObject({
          ok: true,
          status: { version: "1.0.1", siteName: "Anna's Agency" },
        });
        const stored = JSON.stringify(
          await db.run(`select value from settings where key = 'agency_sites'`),
        );
        expect(stored).not.toContain(secretOf(1));
        expect(await listAgencySites(db.runner, anna, siteId)).toHaveLength(1);
        // The name falls back to the site's own name.
        const unnamed = await addAgencySite(
          db.runner,
          anna,
          siteId,
          secrets,
          { code: site(2) },
          ctx(),
        );
        expect(unnamed.ok && unnamed.site.name).toBe("Anna's Agency");
      });

      test("it needs an Agency key and room under its site count (AG-13)", async () => {
        const code = site(1);
        expect(
          await addAgencySite(
            db.runner,
            anna,
            siteId,
            secrets,
            { code },
            ctx({ agency: { active: false, limit: 0 } }),
          ),
        ).toMatchObject({
          ok: false,
          code: "forbidden",
          message: expect.stringMatching(/needs an Agency key/),
        });
        expect(
          (
            await addAgencySite(
              db.runner,
              anna,
              siteId,
              secrets,
              { code },
              ctx({ agency: { active: true, limit: 1 } }),
            )
          ).ok,
        ).toBe(true);
        expect(
          await addAgencySite(
            db.runner,
            anna,
            siteId,
            secrets,
            { code: site(2) },
            ctx({ agency: { active: true, limit: 1 } }),
          ),
        ).toMatchObject({
          ok: false,
          code: "invalid",
          message: expect.stringMatching(/covers 1 site, and 1 is connected/),
        });
        expect(await listAgencySites(db.runner, anna, siteId)).toHaveLength(1);
      });

      test("people who do not manage the site neither connect nor see", async () => {
        expect(
          await addAgencySite(db.runner, editor, siteId, secrets, { code: site(1) }, ctx()),
        ).toMatchObject({ ok: false, code: "forbidden" });
        await addAgencySite(db.runner, anna, siteId, secrets, { code: site(2) }, ctx());
        expect(await listAgencySites(db.runner, editor, siteId)).toEqual([]);
        expect(
          await checkAgencySites(db.runner, editor, siteId, secrets, { ...ctx(), budgetMs: 5000 }),
        ).toMatchObject({ ok: false, code: "forbidden" });
        expect(await removeAgencySite(db.runner, editor, siteId, "x")).toMatchObject({
          ok: false,
          code: "forbidden",
        });
      });

      test("a bad code, a bad address, a wrong key and a site with no connection are each refused in words", async () => {
        const say = async (code: string) => {
          const r = await addAgencySite(db.runner, anna, siteId, secrets, { code }, ctx());
          return r.ok ? "added" : r.message;
        };
        expect(await say("hello")).toBe("This is not a connection code.");
        expect(await say(connectionCode("http://client.example", "key-1", secretOf(1)))).toMatch(
          /https:\/\//,
        );
        site(3);
        expect(await say(connectionCode(`${base}/s3`, "key-3", secretOf(99)))).toMatch(
          /did not accept the key/,
        );
        expect(await say(connectionCode(`${base}/s77`, "key-77", secretOf(77)))).toMatch(
          /no connection switched on/,
        );
        expect(await say(connectionCode("http://127.0.0.1:1", "key-1", secretOf(1)))).toMatch(
          /could not be reached/,
        );
        expect(await listAgencySites(db.runner, anna, siteId)).toEqual([]);
      });

      test("the same site is not connected twice, and a site can be disconnected", async () => {
        const code = site(1);
        const first = await addAgencySite(db.runner, anna, siteId, secrets, { code }, ctx());
        if (!first.ok) throw new Error(first.message);
        expect(
          await addAgencySite(db.runner, anna, siteId, secrets, { code }, ctx()),
        ).toMatchObject({ ok: false, message: expect.stringMatching(/connected already/) });
        expect(await removeAgencySite(db.runner, anna, siteId, first.id)).toEqual({ ok: true });
        expect(await removeAgencySite(db.runner, anna, siteId, first.id)).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(await listAgencySites(db.runner, anna, siteId)).toEqual([]);
      });
    });

    describe("asking the sites (AG-10 to AG-15, AG-83)", () => {
      test("50 sites are asked at once, and one that is down does not hold up the others (AG-83)", async () => {
        for (let n = 1; n <= 50; n++)
          await addAgencySite(
            db.runner,
            anna,
            siteId,
            secrets,
            { code: site(n), name: `Site ${n}` },
            ctx(),
          );
        expect(await listAgencySites(db.runner, anna, siteId)).toHaveLength(50);
        farm.get(17)!.mode = "hang";
        const started = Date.now();
        const r = await checkAgencySites(db.runner, anna, siteId, secrets, {
          ...ctx({ timeoutMs: 600 }),
          budgetMs: 10_000,
        });
        const took = Date.now() - started;
        if (!r.ok) throw new Error(r.message);
        expect(took).toBeLessThan(4000);
        const down = r.sites.filter((s) => !s.last?.ok);
        expect(down.map((s) => s.name)).toEqual(["Site 17"]);
        expect(down[0]!.last).toMatchObject({
          ok: false,
          code: "unreachable",
          error: expect.stringMatching(/could not be reached/),
        });
        expect(r.sites.filter((s) => s.last?.ok)).toHaveLength(49);
        // The new states are kept.
        const saved = await listAgencySites(db.runner, anna, siteId);
        expect(saved.find((s) => s.name === "Site 17")!.last?.ok).toBe(false);
        expect(saved.find((s) => s.name === "Site 3")!.last?.status?.version).toBe("1.0.3");
      });

      test("when the time budget runs out, the sites not reached keep their state and say there was no time", async () => {
        for (let n = 1; n <= 3; n++)
          await addAgencySite(db.runner, anna, siteId, secrets, { code: site(n) }, ctx());
        farm.get(1)!.mode = "hang";
        const r = await checkAgencySites(db.runner, anna, siteId, secrets, {
          ...ctx({ timeoutMs: 400 }),
          budgetMs: 300,
          concurrency: 1,
        });
        if (!r.ok) throw new Error(r.message);
        const codes = r.sites.map((s) => s.last?.code);
        expect(codes[0]).toBe("unreachable");
        expect(codes.slice(1)).toEqual(["late", "late"]);
        expect(r.sites[1]!.last?.error).toMatch(/no time left/);
      });

      test("a clock that is off is said in words (AG-06)", async () => {
        await addAgencySite(db.runner, anna, siteId, secrets, { code: site(1) }, ctx());
        offset = 10 * 60 * 1000;
        const r = await checkAgencySites(db.runner, anna, siteId, secrets, {
          ...ctx(),
          budgetMs: 5000,
        });
        if (!r.ok) throw new Error(r.message);
        expect(r.sites[0]!.last).toMatchObject({
          ok: false,
          code: "clock",
          error: expect.stringMatching(/5 minutes.*Check the time of this server too/),
        });
      });

      test("a changed key, a redirect and a broken site are each told in words", async () => {
        for (let n = 1; n <= 3; n++)
          await addAgencySite(db.runner, anna, siteId, secrets, { code: site(n) }, ctx());
        farm.get(1)!.keys = [{ id: "key-1", secret: secretOf(50) }]; // the site's owner made a new key
        farm.get(2)!.mode = "redirect";
        farm.get(3)!.mode = "broken";
        const r = await checkAgencySites(db.runner, anna, siteId, secrets, {
          ...ctx(),
          budgetMs: 5000,
        });
        if (!r.ok) throw new Error(r.message);
        expect(r.sites[0]!.last).toMatchObject({
          code: "refused",
          error: expect.stringMatching(/did not accept the key/),
        });
        expect(r.sites[1]!.last).toMatchObject({
          code: "refused",
          error: expect.stringMatching(/another address/),
        });
        expect(r.sites[2]!.last).toMatchObject({ code: "failed", error: "The site broke." });
      });

      test("checking needs a valid Agency key; the last known state can still be read", async () => {
        await addAgencySite(db.runner, anna, siteId, secrets, { code: site(1) }, ctx());
        const none = { ...ctx({ agency: { active: false, limit: 0 } }), budgetMs: 5000 };
        expect(await checkAgencySites(db.runner, anna, siteId, secrets, none)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect((await listAgencySites(db.runner, anna, siteId))[0]!.last?.ok).toBe(true);
        expect(
          await fetchSiteReport(
            db.runner,
            anna,
            siteId,
            secrets,
            "x",
            ctx({ agency: { active: false, limit: 0 } }),
          ),
        ).toMatchObject({ ok: false, code: "forbidden" });
        // Disconnecting never needs a key.
        const [one] = await listAgencySites(db.runner, anna, siteId);
        expect(await removeAgencySite(db.runner, anna, siteId, one!.id)).toEqual({ ok: true });
      });

      test("a site's page and visit counts come through the same signed request", async () => {
        await addAgencySite(db.runner, anna, siteId, secrets, { code: site(1) }, ctx());
        const day = new Date().toISOString().slice(0, 10);
        await db.run(
          `insert into stats_daily (site_id, day, kind, key, count) values (?, ?, 'views', '', 9)`,
          [siteId, day],
        );
        const [one] = await listAgencySites(db.runner, anna, siteId);
        const r = await fetchSiteReport(db.runner, anna, siteId, secrets, one!.id, ctx());
        if (!r.ok) throw new Error(r.message);
        expect(r.report).toMatchObject({ days: 30, views: 9 });
        expect(
          await fetchSiteReport(db.runner, anna, siteId, secrets, "nope", ctx()),
        ).toMatchObject({ ok: false, code: "not_found" });
      });

      test("what the site cannot do yet says so, and an oversize body is never sent that far (AG-14)", async () => {
        site(1);
        const target = { url: `${base}/s1`, keyId: "key-1", secret: secretOf(1) };
        const backup = await callSite(target, "/api/oks/v1/backup", ctx(), {
          method: "POST",
          body: {},
        });
        expect(backup).toMatchObject({
          ok: false,
          code: "not_available",
          message: expect.stringMatching(/not built yet/),
        });
        // Redirects are never followed, and a signed request to another path of the same site still passes.
        const status = await callSite(target, "/api/oks/v1/status", ctx());
        expect(status.ok).toBe(true);
        const huge = await callSite(target, "/api/oks/v1/backup", ctx(), {
          method: "POST",
          body: { x: "y".repeat(BODY_MAX_BYTES) },
        });
        expect(huge.ok).toBe(false);
      });
    });
  });
}
