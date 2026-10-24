// The real site, built and started, against SQLite and PostgreSQL. SEO-01 to SEO-09, SEO-50, SEO-55.
import { openers, type TestDb } from "@oks-page/db/testing";
import { type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openSqlite } from "@oks-page/db/testing";
import { buildSite, seed, siteDir, startSite } from "./helpers";

beforeAll(() => buildSite(), 300_000);

for (const { kind, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the site`, () => {
    let db: TestDb;
    let server: ChildProcess;
    let base = "";
    let ids: Record<string, string> = {};
    let entry: Awaited<ReturnType<typeof seed>>["entry"];

    const get = (path: string, init?: RequestInit) =>
      fetch(base + path, { redirect: "manual", ...init });
    const text = async (path: string) => (await get(path)).text();
    const stats = async (reset = false) =>
      (await (await get(`/api/test/loads${reset ? "?reset" : ""}`)).json()) as {
        loads: Record<string, number>;
        proxyMs: number[];
      };
    const refresh = (body: object) =>
      get("/api/test/refresh", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
    const retitle = (id: string, title: string) =>
      db.run("update entries set title = ?, html = ? where id = ?", [
        title,
        `<p>${title} body</p>`,
        id,
      ]);

    beforeAll(async () => {
      db =
        kind === "sqlite"
          ? await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-site-")), "site.sqlite"))
          : await (await import("@oks-page/db/testing")).openPg();
      const s = await seed(db);
      entry = s.entry;
      ids = {
        home: await entry("home", "Home"),
        about: await entry("about", "About us"),
        contact: await entry("contact", "Contact"),
        draft: await entry("draft-page", "Draft", "draft"),
        priv: await entry("private-page", "Private", "private"),
        trash: await entry("trashed-page", "Trashed", "trash"),
        sched: await entry("scheduled-page", "Scheduled", "scheduled"),
      };
      const started = await startSite(kind, db);
      server = started.server;
      base = started.base;
    }, 120_000);

    afterAll(async () => {
      server?.kill();
      await db?.close();
    });

    test("SEO-01 a published page shows its title and body", async () => {
      const res = await get("/about");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<title>About us</title>");
      expect(html).toContain("About us body");
      expect(await text("/")).toContain("<h1>Home</h1>");
    });

    test("SEO-02 the cache holds: a second visit does not read the database again", async () => {
      await stats(true);
      await text("/contact");
      await text("/contact");
      await text("/contact");
      expect((await stats()).loads["entry:contact"]).toBe(1);
    });

    test("SEO-03 revalidateTag with 'max' serves the old page once while it refreshes, then the new one", async () => {
      await text("/about");
      await retitle(ids["about"]!, "About v2");
      await refresh({ tag: `entry:${ids["about"]}`, mode: "max" });
      const first = await text("/about");
      expect(first).toContain("About us"); // stale-while-revalidate: the old page is served while the new one is made
      await new Promise((r) => setTimeout(r, 300));
      expect(await text("/about")).toContain("About v2");
    });

    test("SEO-04 revalidateTag with expire 0 makes the next visit fresh", async () => {
      await retitle(ids["about"]!, "About v3");
      await refresh({ tag: `entry:${ids["about"]}`, mode: "expire0" });
      expect(await text("/about")).toContain("About v3");
    });

    test("SEO-05 refreshing one entry does not refresh the others", async () => {
      await text("/contact");
      await stats(true);
      await retitle(ids["about"]!, "About v4");
      await refresh({ tag: `entry:${ids["about"]}`, mode: "expire0" });
      await text("/about");
      await text("/contact");
      const { loads } = await stats();
      expect(loads["entry:about"]).toBe(1);
      expect(loads["entry:contact"]).toBeUndefined();
    });

    test("SEO-07 an unknown address is a real 404 with noindex, from the proxy", async () => {
      const res = await get("/no/such/page");
      expect(res.status).toBe(404);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(await res.text()).toContain('content="noindex"');
    });

    test("SEO-09 a newly created entry is reachable at once", async () => {
      expect((await get("/fresh-page")).status).toBe(404);
      await entry("fresh-page", "Fresh");
      const res = await get("/fresh-page");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<h1>Fresh</h1>");
    });

    test("SEO-50 draft, private, trashed and scheduled entries are 404; published ones are 200", async () => {
      for (const slug of ["draft-page", "private-page", "trashed-page", "scheduled-page"])
        expect((await get(`/${slug}`)).status, slug).toBe(404);
      for (const slug of ["about", "contact", "home"])
        expect((await get(`/${slug}`)).status, slug).toBe(200);
    });

    test("SEO-50 publishing a draft makes it appear; unpublishing it removes it", async () => {
      expect((await get("/draft-page")).status).toBe(404);
      await db.run("update entries set status = 'published' where id = ?", [ids["draft"]]);
      expect((await get("/draft-page")).status).toBe(200);
      await db.run("update entries set status = 'draft' where id = ?", [ids["draft"]]);
      expect((await get("/draft-page")).status).toBe(404);
    });

    test("SEO-55 no entry is prerendered at build time", () => {
      const manifest = JSON.parse(
        readFileSync(join(siteDir, ".next", "prerender-manifest.json"), "utf8"),
      ) as { routes: Record<string, unknown> };
      const prerendered = Object.keys(manifest.routes);
      for (const slug of ["/about", "/contact", "/home", "/"])
        expect(prerendered, slug).not.toContain(slug);
      expect(existsSync(join(siteDir, ".next", "server", "app", "about.html"))).toBe(false);
    });
  });
}

for (const { kind, skip } of openers) {
  describe.skipIf(skip)(`${kind}: two server processes on one database (SEO-59)`, () => {
    let db: TestDb;
    let a: Awaited<ReturnType<typeof startSite>>;
    let b: Awaited<ReturnType<typeof startSite>>;
    let c: Awaited<ReturnType<typeof startSite>>;
    let ids: Record<string, string> = {};

    const text = async (site: { base: string }, path: string) =>
      (await fetch(site.base + path)).text();
    const refresh = (site: { base: string }, body: object) =>
      fetch(site.base + "/api/test/refresh", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
    const retitle = (id: string, title: string) =>
      db.run("update entries set title = ?, html = ? where id = ?", [
        title,
        `<p>${title} body</p>`,
        id,
      ]);

    beforeAll(async () => {
      db =
        kind === "sqlite"
          ? await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-two-")), "site.sqlite"))
          : await (await import("@oks-page/db/testing")).openPg();
      const s = await seed(db);
      ids = {
        about: await s.entry("about", "About us"),
        contact: await s.entry("contact", "Contact"),
      };
      a = await startSite(kind, db);
      b = await startSite(kind, db);
      // The control: a third process that does not look at the shared table.
      c = await startSite(kind, db, { OKS_CACHE_SHARED: "0" });
    }, 180_000);

    afterAll(async () => {
      for (const s of [a, b, c]) s?.server.kill();
      await db?.close();
    });

    test("SEO-59 a change made through process A shows in process B on its next request", async () => {
      for (const s of [a, b, c]) expect(await text(s, "/about")).toContain("About us");
      await retitle(ids["about"]!, "About v2");
      await refresh(a, { tag: `entry:${ids["about"]}`, mode: "expire0" });
      expect(await text(a, "/about")).toContain("About v2");
      expect(await text(b, "/about")).toContain("About v2"); // within one request
    });

    test("control: a process that does not read the shared table keeps showing the old page", async () => {
      expect(await text(c, "/about")).toContain("About us");
    });

    test("SEO-59 a time-based refresh ('max') through A: B serves the old page once, then the new one", async () => {
      await text(b, "/contact");
      await retitle(ids["contact"]!, "Contact v2");
      await refresh(a, { tag: `entry:${ids["contact"]}`, mode: "max" });
      expect(await text(b, "/contact")).toContain("Contact"); // the first visit: old page, renewed in the background
      await new Promise((r) => setTimeout(r, 400));
      expect(await text(b, "/contact")).toContain("Contact v2");
    });

    test("a refresh of one entry does not touch the other entry in process B", async () => {
      await stats(b, true);
      await text(b, "/contact");
      await retitle(ids["about"]!, "About v3");
      await refresh(a, { tag: `entry:${ids["about"]}`, mode: "expire0" });
      await text(b, "/about");
      await text(b, "/contact");
      const { loads } = await stats(b);
      expect(loads["entry:about"]).toBe(1);
      expect(loads["entry:contact"]).toBeUndefined();
    });
  });
}

async function stats(site: { base: string }, reset = false) {
  return (await (await fetch(`${site.base}/api/test/loads${reset ? "?reset" : ""}`)).json()) as {
    loads: Record<string, number>;
    proxyMs: number[];
  };
}

for (const { kind, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the header contract for a CDN (D81)`, () => {
    let db: TestDb;
    let site: Awaited<ReturnType<typeof startSite>>;
    let entryId = "";
    let siteId = "";

    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(site.base + path, { redirect: "manual", headers });
    const cdn = async (enabled: boolean) => {
      await db.run("delete from settings where key = 'cdn'");
      await db.run(
        "insert into settings (site_id, key, value, updated_at) values (?, 'cdn', ?, ?)",
        [siteId, JSON.stringify({ enabled }), new Date()],
      );
    };

    beforeAll(async () => {
      db =
        kind === "sqlite"
          ? await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-hdr-")), "site.sqlite"))
          : await (await import("@oks-page/db/testing")).openPg();
      const s = await seed(db);
      siteId = s.site;
      entryId = await s.entry("about", "About us");
      await s.entry("home", "Home");
      site = await startSite(kind, db, { OKS_SETTINGS_TTL_MS: "0" });
    }, 120_000);

    afterAll(async () => {
      site?.server.kill();
      await db?.close();
    });

    test("CDN setting off (the default): an anonymous page keeps the Next.js headers and has no tags", async () => {
      const res = await get("/about");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
      expect(res.headers.get("cache-tag")).toBeNull();
    });

    test("CDN setting on: an anonymous published page is public for 5 minutes and carries site, entry and type tags", async () => {
      await cdn(true);
      const res = await get("/about");
      expect(res.headers.get("cache-control")).toBe(
        "public, s-maxage=300, stale-while-revalidate=3600",
      );
      expect(res.headers.get("cache-tag")).toBe(`site:${siteId},entry:${entryId},type:page`);
    });

    test("a public page sets no cookie", async () => {
      expect((await get("/about")).headers.getSetCookie()).toEqual([]);
    });

    test("a signed-in visitor (session cookie) gets private, no-store and no tags", async () => {
      const res = await get("/about", { cookie: "better-auth.session_token=abc" });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("cache-tag")).toBeNull();
    });

    test("a preview (Draft Mode cookie) gets private, no-store", async () => {
      const res = await get("/about", { cookie: "__prerender_bypass=abc" });
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });

    test("a 404 is public for 60 seconds with the CDN on, and private for a signed-in visitor", async () => {
      const res = await get("/nothing-here");
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("public, s-maxage=60");
      expect(
        (await get("/nothing-here", { cookie: "better-auth.session_token=abc" })).headers.get(
          "cache-control",
        ),
      ).toBe("private, no-store");
    });

    test("the API is never public, whatever the setting", async () => {
      const res = await get("/api/test/loads");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });

    test("files under /_next/static are immutable", async () => {
      const html = await (await get("/about")).text();
      const file = /\/_next\/static\/[^"']+\.(?:js|css)/.exec(html)?.[0];
      expect(file, "the page links a static file").toBeTruthy();
      expect((await get(file!)).headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });

    test("an HTML request and a client-navigation (RSC) request both get the public header, and both tell the CDN to keep them apart", async () => {
      const html = await get("/about");
      // A real client navigation asks with the rsc header and a _rsc query value.
      const rsc = await fetch(site.base + "/about?_rsc=abc", { headers: { rsc: "1" } }); // follows Next.js's redirect to the right _rsc value
      expect(rsc.headers.get("cache-control")).toBe(
        "public, s-maxage=300, stale-while-revalidate=3600",
      );
      for (const res of [html, rsc])
        expect((res.headers.get("vary") ?? "").toLowerCase()).toContain("rsc");
      expect(rsc.headers.get("content-type")).not.toBe(html.headers.get("content-type"));
    });

    test("turning the setting off again takes the public header away", async () => {
      await cdn(false);
      expect((await get("/about")).headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
    });
  });
}
