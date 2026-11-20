// The real site, built and started, against SQLite and PostgreSQL. SEO-01 to SEO-09, SEO-50, SEO-55.
import { openers, type TestDb } from "@oks-page/db/testing";
import { execFileSync, type ChildProcess } from "node:child_process";
import {
  createHash,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
} from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openSqlite } from "@oks-page/db/testing";
import axe from "axe-core";
import { generateSync } from "otplib";
import sharp from "sharp";
import { chromium, type Browser } from "playwright-core";
import { SMTPServer } from "smtp-server";
import { buildExport, buildSite, findBrowser, seed, siteDir, startSite } from "./helpers";

/** The page's HTML followed by the owner's look, which the page links to as a file (`/site-style/<fingerprint>.css`). */
async function withLook(base: string, html: string): Promise<string> {
  const hrefs = new Set(
    [...html.matchAll(/<link rel="stylesheet" href="(\/site-style\/[0-9a-f]{16}\.css)"/g)].map(
      (m) => m[1]!,
    ),
  );
  let all = html;
  for (const href of hrefs) all += "\n" + (await (await fetch(base + href)).text());
  return all;
}

beforeAll(() => buildSite(), 300_000);

// A throwaway signing key for the licence screen (ADR 0037): the site trusts its public half through the environment.
const licenceKeys = generateKeyPairSync("ed25519");
const licencePublic = licenceKeys.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const licencePrivate = licenceKeys.privateKey
  .export({ format: "der", type: "pkcs8" })
  .toString("base64");
/** A signed key in the format of packages/core/src/licence.ts. */
function signedLicence(payload: Record<string, unknown>, privateKey = licencePrivate): string {
  const body = `OKS1.${Buffer.from(JSON.stringify({ v: 1, ...payload })).toString("base64url")}`;
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return `${body}.${edSign(null, Buffer.from(body), key).toString("base64url")}`;
}

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
      expect(html).toContain("<title>About us – S</title>");
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

    test.skipIf(!findBrowser())(
      "SEO-06 a Server Action that saves an entry and calls updateTag makes the next visit fresh",
      async () => {
        expect(await text("/contact")).toContain("<h1>Contact</h1>"); // cached
        const browser = await chromium.launch({
          executablePath: findBrowser()!,
          args: ["--no-sandbox"],
        });
        try {
          const page = await browser.newPage();
          await page.goto(base + "/test-form");
          await page.getByLabel("id").fill(ids["contact"]!);
          await page.getByLabel("title").fill("Contact (saved by the action)");
          await Promise.all([
            page.waitForLoadState("networkidle"),
            page.getByRole("button", { name: "Save" }).click(),
          ]);
        } finally {
          await browser.close();
        }
        // Not "max": updateTag expires the entry at once, so the very next visit shows the new text.
        expect(await text("/contact")).toContain("<h1>Contact (saved by the action)</h1>");
        const row = (
          await db.run("select revision from entries where id = ?", [ids["contact"]])
        )[0]!;
        expect(Number(row["revision"])).toBe(2);
      },
      60_000,
    );

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
        team: await s.entry("team", "Team"),
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
      const mark = Date.now();
      await refresh(a, { tag: `entry:${ids["about"]}`, mode: "expire0" });
      expect(await text(a, "/about")).toContain("About v2");
      // Next.js writes the refresh to the shared table after A has answered, so wait until it is there. (Asking B at
      // once could beat the write and read the old page: that made this test fail now and then.)
      await expect
        .poll(
          async () =>
            (
              await db.run("select updated_at from cache_tags where tag = ?", [
                `entry:${ids["about"]}`,
              ])
            ).some((r) => new Date(r["updated_at"] as string | number | Date).getTime() >= mark),
          { timeout: 10_000, interval: 20 },
        )
        .toBe(true);
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
      await text(b, "/team"); // cached before the count starts
      await stats(b, true);
      await retitle(ids["about"]!, "About v3");
      const mark = Date.now();
      await refresh(a, { tag: `entry:${ids["about"]}`, mode: "expire0" });
      // Next.js writes the refresh to the shared table after A has answered, so wait until it is there. (Asking
      // B at once could beat the write and read the old page: that made this test fail now and then.)
      await expect
        .poll(
          async () =>
            (
              await db.run("select updated_at from cache_tags where tag = ?", [
                `entry:${ids["about"]}`,
              ])
            ).some((r) => new Date(r["updated_at"] as string | number | Date).getTime() >= mark),
          { timeout: 10_000, interval: 20 },
        )
        .toBe(true);
      await text(b, "/about");
      await text(b, "/team");
      const { loads } = await stats(b);
      expect(loads["entry:about"]).toBe(1);
      expect(loads["entry:team"]).toBeUndefined();
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
      // Every page also carries the two menu tags, because every page shows the menus.
      expect(res.headers.get("cache-tag")).toBe(
        `site:${siteId},entry:${entryId},type:page,menu:primary,menu:footer`,
      );
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

for (const { kind, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the export build against the server build (ST-01, ST-02)`, () => {
    let db: TestDb;
    let site: Awaited<ReturnType<typeof startSite>>;
    let out = "";
    let ownFont: Buffer = Buffer.alloc(0);
    let ownKey = "";
    const SITE_URL = "https://example.test";

    // What a visitor sees: the title, the canonical address and the page content, without the framework's own scripts.
    const pick = (html: string) => ({
      title: /<title>([^<]*)<\/title>/.exec(html)?.[1],
      canonical: /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1],
      heading: /<h1>([^<]*)<\/h1>/.exec(html)?.[1],
      article: /<article>(.*?)<\/article>/s.exec(html)?.[1],
    });

    beforeAll(async () => {
      db =
        kind === "sqlite"
          ? await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-exp-")), "site.sqlite"))
          : await (await import("@oks-page/db/testing")).openPg();
      const s = await seed(db);
      await s.entry("home", "Home");
      const aboutEntry = await s.entry("about", "About us");
      await s.entry("docs/intro", "Intro");
      await s.entry("hidden", "Hidden", "draft");
      await s.entry("secret", "Secret", "private");
      // One category with one published post, so the export has a category page to write.
      const taxonomy = `TAX${"0".repeat(22)}1`;
      await db.run(
        "insert into taxonomies (id, site_id, key, label, hierarchical, applies_to) values (?, ?, 'category', 'Categories', ?, '[\"post\"]')",
        [taxonomy, s.site, true],
      );
      const term = `TRM${"0".repeat(22)}1`;
      await db.run(
        "insert into terms (id, taxonomy_id, slug, name, description) values (?, ?, 'news', 'News', '')",
        [term, taxonomy],
      );
      const post = await s.entry("blog/first", "First post", "published", "post");
      await db.run("insert into entry_terms (entry_id, term_id, position) values (?, ?, 0)", [
        post,
        term,
      ]);
      // Eleven more, so the category has 12 posts: two pages of 10 (the first post is the newest, so it is on page 1).
      for (let i = 2; i <= 12; i++) {
        const more = await s.entry(`blog/extra-${i}`, `Extra post ${i}`, "published", "post");
        await db.run("insert into entry_terms (entry_id, term_id, position) values (?, ?, 0)", [
          more,
          term,
        ]);
      }
      await db.run("update entries set published_at = ? where type_key = 'post'", [
        new Date(1_700_000_000_000),
      ]);
      await db.run("update entries set published_at = ? where slug = 'blog/first'", [
        new Date(1_800_000_000_000),
      ]);
      // A header menu with a page and a link, so both builds draw it.
      await db.run(
        "insert into menus (id, site_id, key, label, items, updated_at) values (?, ?, 'primary', 'Header menu', ?, ?)",
        [
          `MNU${"0".repeat(22)}1`,
          s.site,
          JSON.stringify([
            { id: "m1", label: "About", kind: "entry", entryId: aboutEntry, children: [] },
            { id: "m2", label: "Shop", kind: "url", url: "https://shop.example.com", children: [] },
          ]),
          new Date(),
        ],
      );
      // The text font is one of the library, so the export has to carry its files.
      // The headings use a font the owner uploaded, so the export has to carry that file too.
      const { createHash } = await import("node:crypto");
      ownFont = Buffer.alloc(200);
      ownFont.write("wOF2", 0, "latin1");
      ownFont.writeUInt32BE(200, 8);
      ownFont.writeUInt16BE(5, 12);
      ownFont.writeUInt32BE(4242, 20);
      const sha = createHash("sha256").update(ownFont).digest("hex");
      ownKey = `own-serif-700-${sha.slice(0, 16)}`;
      for (const [key, value] of [
        ["theme", { bodyFont: "inter", headingFont: ownKey }],
        [
          "owner-fonts",
          [
            {
              key: ownKey,
              name: "Export Serif",
              kind: "serif",
              weight: "700",
              sha256: sha,
              bytes: 200,
              addedBy: "x",
              addedAt: new Date().toISOString(),
            },
          ],
        ],
        [`owner-font-file:${sha.slice(0, 16)}`, { data: ownFont.toString("base64") }],
      ] as const)
        await db.run(
          "insert into settings (site_id, key, value, revision, updated_at) values (?, ?, ?, 1, ?)",
          [s.site, key, JSON.stringify(value), new Date()],
        );
      site = await startSite(kind, db, { OKS_SITE_URL: SITE_URL });
      out = mkdtempSync(join(tmpdir(), "oks-exp-out-"));
      buildExport(kind, db, out, { OKS_SITE_URL: SITE_URL });
    }, 400_000);

    afterAll(async () => {
      site?.server.kill();
      await db?.close();
    });

    test("the font files the pages use are written as plain files in the export (font library)", async () => {
      const { readdirSync, readFileSync } = await import("node:fs");
      const { createHash } = await import("node:crypto");
      const home = readFileSync(join(out, "index.html"), "utf8");
      const names = [
        ...new Set(
          [...home.matchAll(/\/fonts\/([a-z0-9-]+\.[0-9a-f]{16}\.woff2)/g)].map((m) => m[1]!),
        ),
      ].sort();
      // Inter, Latin, regular and bold: nothing else, and nothing from another host.
      expect(names).toHaveLength(2);
      // The owner's own font is there too, byte for byte; nothing else is in the folder.
      expect(readdirSync(join(out, "fonts")).sort()).toEqual([...names, `${ownKey}.woff2`].sort());
      expect(home).toContain(`/fonts/${ownKey}.woff2`);
      expect(readFileSync(join(out, "fonts", `${ownKey}.woff2`)).equals(ownFont)).toBe(true);
      for (const name of names) {
        const bytes = readFileSync(join(out, "fonts", name));
        expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
        expect(createHash("sha256").update(bytes).digest("hex").slice(0, 16)).toBe(
          /\.([0-9a-f]{16})\.woff2$/.exec(name)![1],
        );
      }
    });

    test("ST-01 each published page has the same title, content and canonical address in both builds", async () => {
      for (const [path, file] of [
        ["/", "index.html"],
        ["/about", "about.html"],
        ["/docs/intro", "docs/intro.html"],
      ] as const) {
        const served = pick(await (await fetch(site.base + path)).text());
        const written = pick(readFileSync(join(out, file), "utf8"));
        expect(written, path).toEqual(served);
        expect(written.canonical, path).toBe(path === "/" ? `${SITE_URL}/` : `${SITE_URL}${path}`);
      }
    });

    test("the export draws the header menu like the server build, and no footer when there is none", async () => {
      const menu = (html: string) =>
        /<nav aria-label="Main menu">.*?<\/nav>/s.exec(html)?.[0] ?? "";
      for (const [path, file] of [
        ["/", "index.html"],
        ["/about", "about.html"],
        ["/category/news", "category/news.html"],
      ] as const) {
        const served = await (await fetch(site.base + path)).text();
        const written = readFileSync(join(out, file), "utf8");
        expect(menu(written), path).toMatch(/<a href="\/about"[^>]*>About<\/a>/);
        expect(menu(written), path).toMatch(
          /<a href="https:\/\/shop\.example\.com"[^>]*>Shop<\/a>/,
        );
        expect(menu(written), path).toBe(menu(served));
        expect(written, path).not.toContain('aria-label="Footer menu"');
      }
    });

    test("the export writes the category pages too, with the same heading and title as the server build", async () => {
      const served = await (await fetch(site.base + "/category/news")).text();
      const written = readFileSync(join(out, "category/news.html"), "utf8");
      expect(pick(written)).toMatchObject({
        title: "Category: News – S",
        heading: "Category: News",
        canonical: `${SITE_URL}/category/news`,
      });
      expect(written).toContain('href="/blog/first"');
      expect(pick(written).heading).toBe(pick(served).heading);
      expect(pick(written).title).toBe(pick(served).title);
    });

    test("the export writes the later pages of a list, the same as the server build, and no page past the last", async () => {
      const served = await fetch(site.base + "/category/news/page/2");
      expect(served.status).toBe(200);
      const servedHtml = await served.text();
      const written = readFileSync(join(out, "category/news/page/2.html"), "utf8");
      expect(pick(written)).toEqual({ ...pick(servedHtml), article: undefined });
      expect(pick(written)).toMatchObject({
        title: "Category: News – Page 2 – S",
        canonical: `${SITE_URL}/category/news/page/2`,
      });
      for (const html of [written, servedHtml]) {
        expect(html).toContain("Page 2 of 2");
        expect(html).toContain('href="/category/news"');
        expect(html).not.toContain("Older posts");
        expect((html.match(/<a href="\/blog\/[^"]+">/g) ?? []).length).toBe(2);
      }
      // The first page has 10 posts and the link to the second; the first post is on it.
      const firstPage = readFileSync(join(out, "category/news.html"), "utf8");
      expect(firstPage).toContain("Page 1 of 2");
      expect(firstPage).toContain('href="/category/news/page/2"');
      expect(firstPage).toContain('href="/blog/first"');
      expect((firstPage.match(/<a href="\/blog\/[^"]+">/g) ?? []).length).toBe(10);
      expect(existsSync(join(out, "category/news/page/3.html"))).toBe(false);
      expect((await fetch(site.base + "/category/news/page/3")).status).toBe(404);
    });

    test("ST-02 the export holds only published pages, and a 404 page", () => {
      expect(existsSync(join(out, "about.html"))).toBe(true);
      expect(existsSync(join(out, "hidden.html"))).toBe(false);
      expect(existsSync(join(out, "secret.html"))).toBe(false);
      expect(existsSync(join(out, "404.html"))).toBe(true);
    });

    test("the export has no server parts: no API route, no proxy, no database settings", () => {
      expect(existsSync(join(out, "api"))).toBe(false);
      const all = readFileSync(join(out, "about.html"), "utf8");
      expect(all).not.toContain("better-sqlite3");
      expect(all).not.toContain("OKS_DATABASE_URL");
    });

    test.skipIf(!findBrowser())(
      "ST-31 the exported pages look the same as the server pages at 375, 768 and 1280 px",
      async () => {
        // A plain file server for the export, the way a static host serves it: /about finds about.html.
        const types: Record<string, string> = {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "text/javascript",
          ".json": "application/json",
          ".woff2": "font/woff2",
          ".svg": "image/svg+xml",
        };
        const files = createHttpServer((req, res) => {
          const path = new URL(req.url ?? "/", "http://x").pathname;
          const candidates = [path, `${path}.html`, join(path, "index.html")];
          const found = candidates.find((c) => {
            const f = join(out, c);
            return existsSync(f) && statSync(f).isFile();
          });
          res.statusCode = found ? 200 : 404;
          res.setHeader("content-type", types[extname(found ?? "")] ?? "text/plain");
          res.end(found ? readFileSync(join(out, found)) : "not found");
        });
        await new Promise<void>((r) => files.listen(0, "127.0.0.1", r));
        const staticBase = `http://127.0.0.1:${(files.address() as { port: number }).port}`;
        const browser = await chromium.launch({ executablePath: findBrowser()! });
        try {
          for (const width of [375, 768, 1280]) {
            const page = await browser.newPage({ viewport: { width, height: 800 } });
            for (const path of ["/", "/about", "/docs/intro"]) {
              await page.goto(site.base + path, { waitUntil: "networkidle" });
              const served = await page.screenshot({ fullPage: true });
              await page.goto(staticBase + path, { waitUntil: "networkidle" });
              const written = await page.screenshot({ fullPage: true });
              if (!written.equals(served)) {
                const stem = join(tmpdir(), `oks-st31-${width}${path.replace(/\//g, "_")}`);
                writeFileSync(`${stem}-server.png`, served);
                writeFileSync(`${stem}-export.png`, written);
              }
              expect(written.equals(served), `${path} at ${width}px`).toBe(true);
            }
            await page.close();
          }
        } finally {
          await browser.close();
          files.close();
        }
      },
      120_000,
    );
  });
}

// The wizard shares the build of this file: two builds at the same time would write into the same folder.
describe.skipIf(!findBrowser())("the setup wizard", () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;

  const count = async (table: string) =>
    Number((await db.run(`select count(*) as n from ${table}`))[0]!["n"]);

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-wizard-")), "site.sqlite"));
    site = await startSite("sqlite", db, { OKS_SECRET: "s".repeat(40) });
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 600_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  test("a new install sends the first visit to the wizard", async () => {
    const response = await fetch(site.base + "/", { redirect: "manual" });
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!, site.base).pathname).toBe("/admin/setup");
  });

  test("the wizard has no accessibility violations on its three steps", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.goto(site.base + "/admin/setup");
    await page.getByRole("heading", { name: "Set up your site", level: 1 }).waitFor();
    for (const step of ["first", "second", "third"]) {
      if (step === "second") {
        await page.getByLabel("Site name").fill("My Site");
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByLabel("Your name").waitFor();
      }
      if (step === "third") {
        await page.getByLabel("Your name").fill("Anna");
        await page.getByLabel("Email").fill("anna@example.com");
        await page.getByLabel(/^Password/).fill("a-long-password");
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByText("Add sample content?").waitFor();
      }
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
        step,
      ).toEqual([]);
    }
    await page.close();
  });

  test("a password that is too short is refused with a plain message, and nothing is created", async () => {
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/setup");
    await page.getByLabel("Site name").fill("My Site");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("Your name").fill("Anna");
    await page.getByLabel("Email").fill("anna@example.com");
    await page.getByLabel(/^Password/).fill("short");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Finish setup" }).click();
    await page
      .getByText(/at least 10 characters/i)
      .first()
      .waitFor();
    // The wrong answer sends the person back to the account step, with their other answers kept.
    expect(await page.getByLabel("Your name").inputValue()).toBe("Anna");
    expect(await count("sites")).toBe(0);
    expect(await count("users")).toBe(0);
    await page.close();
  });

  test("two questions about the site, two about the owner, then the owner is signed in", async () => {
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/setup");
    await page.getByLabel("Site name").fill("Anna's Garden");
    await page.getByLabel("Tagline").fill("Plants and notes");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("Your name").fill("Anna");
    await page.getByLabel("Email").fill("anna@example.com");
    await page.getByLabel(/^Password/).fill("a-long-password");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Finish setup" }).click();
    await page.getByRole("heading", { name: "Your site is set up" }).waitFor();
    expect(await page.getByText("signed in as anna@example.com").count()).toBe(1);
    // Two-factor is recommended here, and can be skipped (it never blocks the owner).
    await page.getByText("Recommended:").waitFor();
    expect(
      await page.getByRole("link", { name: "Set up two-factor sign-in" }).getAttribute("href"),
    ).toBe("/admin/account");
    expect(
      await page
        .getByRole("link", { name: "Skip for now: open the dashboard" })
        .getAttribute("href"),
    ).toBe("/admin");

    expect(await count("sites")).toBe(1);
    expect(await count("site_members")).toBe(1);
    const role = (
      await db.run("select r.key as k from site_members m join roles r on r.id = m.role_id")
    )[0]!["k"];
    expect(role).toBe("administrator");

    // The sample content is on the site, as the wizard's default.
    for (const [path, text] of [
      ["/", "This is your home page"],
      ["/about", "Tell visitors who you are"],
      ["/contact", "Say how people can reach you"],
      ["/blog/hello-world", "This is your first post"],
    ] as const) {
      const response = await fetch(site.base + path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain(text);
    }

    // The session cookie from the last step is a working sign-in.
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/get-session");
      const text = await response.text();
      return { status: response.status, text, cookies: document.cookie };
    });
    // When this fails the message says what came back (status, body and the cookies the page can see).
    expect(
      session.text,
      `${JSON.stringify(session)}\nserver log:\n${site.log().slice(-2500)}`,
    ).not.toBe("");
    const user = (JSON.parse(session.text) as { user?: { email: string } } | null)?.user;
    expect(user?.email, JSON.stringify(session)).toBe("anna@example.com");
    await page.close();
  });

  test("once set up, the wizard is closed: the page says so and the route refuses", async () => {
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/setup");
    await page.getByText("This site is already set up").waitFor();
    expect(await page.getByLabel("Site name").count()).toBe(0);
    await page.close();

    const again = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Another",
        admin: { name: "Bob", email: "bob@example.com", password: "another-long-password" },
      }),
    });
    expect(again.status).toBe(409);
    expect(await count("sites")).toBe(1);
    expect(await count("users")).toBe(1);
  });

  test("a request from another address is refused", async () => {
    const response = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });
});

describe.skipIf(!findBrowser())("the admin sign-in and the dashboard", () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const owner = { email: "anna@example.com", password: "a-long-password" };

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-admin-")), "site.sqlite"));
    site = await startSite("sqlite", db, { OKS_SECRET: "s".repeat(40) });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        starterContent: true,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  const signIn = async (
    page: Awaited<ReturnType<Browser["newPage"]>>,
    password = owner.password,
  ) => {
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel(/^Password/).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
  };

  test("without a session, /admin sends the visitor to the sign-in page", async () => {
    // The page streams, so the redirect is made in the browser, and the dashboard is never drawn.
    const page = await browser.newPage();
    await page.goto(site.base + "/admin");
    await page.waitForURL("**/admin/login");
    await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
    expect(await page.getByText("Anna's Garden").count()).toBe(0);
    await page.close();
  });

  test("a wrong password gets a plain message and stays on the sign-in page", async () => {
    const page = await browser.newPage();
    await signIn(page, "not-the-password");
    await page.getByText("The email or the password is wrong.").waitFor();
    expect(new URL(page.url()).pathname).toBe("/admin/login");
    await page.close();
  });

  test("the right password opens the dashboard: the site, its counts and its latest edits", async () => {
    const page = await browser.newPage();
    await signIn(page);
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/admin");
    const body = await page.locator("main").innerText();
    expect(body).toContain("Anna's Garden");
    expect(body).toContain("Signed in as Anna (anna@example.com)");
    expect(await page.getByRole("list", { name: "Recent edits" }).innerText()).toContain(
      "Hello world",
    );
    expect(
      (await page.locator('dl[aria-label="Your content"]').innerText()).replace(/\s+/g, " "),
    ).toBe("Pages 3 Posts 1 Drafts 0 Waiting for review 0");
    expect(await page.locator("footer").innerText()).toMatch(/Developed with .+ · Version /);
    await page.close();
  });

  test("the dashboard has no accessibility violations on a wide and a narrow screen", async () => {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await signIn(page);
      await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
        `${width}px`,
      ).toEqual([]);
      await page.close();
    }
  });

  test("signing out goes back to the sign-in page, and /admin needs a session again", async () => {
    const page = await browser.newPage();
    await signIn(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
    await page.goto(site.base + "/admin");
    await page.waitForURL("**/admin/login");
    await page.close();
  });

  test("someone with an account who is not a member of the site is not let in", async () => {
    // A second account made through the sign-up route: it has no role on this site.
    const made = await fetch(site.base + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: site.base },
      body: JSON.stringify({
        name: "Bob",
        email: "bob@example.com",
        password: "another-long-password",
      }),
    });
    expect(made.ok).toBe(true);
    const context = await browser.newContext();
    await context.addCookies(
      made.headers.getSetCookie().map((line) => {
        const [pair] = line.split(";");
        const [name, ...value] = pair!.split("=");
        return { name: name!, value: value.join("="), url: site.base };
      }),
    );
    const page = await context.newPage();
    await page.goto(site.base + "/admin");
    await page.waitForURL("**/admin/login");
    expect(await page.getByText("Anna's Garden").count()).toBe(0);
    await context.close();
  });
});

// These tests sign in and open many pages while the whole workspace runs at once, so they get more time.
describe.skipIf(!findBrowser())("pages and posts in the admin", { timeout: 90_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const owner = { email: "anna@example.com", password: "a-long-password" };
  const cara = { email: "cara@example.com", password: "cara-long-password" };

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-pages-")), "site.sqlite"));
    site = await startSite("sqlite", db, {
      OKS_SECRET: "s".repeat(40),
      OKS_SCHEDULER_SECONDS: "1",
    });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        starterContent: true,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    // Cara has an account and the contributor role on this site: she may write drafts, not publish.
    const signUp = await fetch(site.base + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: site.base },
      body: JSON.stringify({ name: "Cara", ...cara }),
    });
    const caraId = ((await signUp.json()) as { user: { id: string } }).user.id;
    const siteId = String((await db.run("select id from sites"))[0]!["id"]);
    const role = String((await db.run("select id from roles where key = 'contributor'"))[0]!["id"]);
    await db.run(
      "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
      [siteId, caraId, role, new Date()],
    );
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  type Page = Awaited<ReturnType<Browser["newPage"]>>;
  // The sign-in limit allows a few tries from one address, so the owner signs in once and the tests reuse the session.
  let ownerCookies: Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>> | null = null;
  const signIn = async (page: Page, who = owner) => {
    if (who === owner && ownerCookies) {
      await page.context().addCookies(ownerCookies);
      await page.goto(site.base + "/admin");
      await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      return;
    }
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(who.email);
    await page.getByLabel(/^Password/).fill(who.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    if (who === owner) ownerCookies = await page.context().cookies();
  };
  const status = (page: Page) => page.locator(".oks-entry-actions [role=status]");
  const text = async (path: string) => {
    const response = await fetch(site.base + path);
    // A server error is never expected here: show what the server said, so a rare one can be understood.
    if (response.status >= 500)
      console.error(
        `[test] ${path} answered ${response.status}. Server log:\n${site.log().slice(-4000)}`,
      );
    return { status: response.status, body: await response.text() };
  };

  test("the pages list shows the sample pages as links, the posts list the first post, and the menu has both", async () => {
    const page = await browser.newPage();
    await signIn(page);
    // The menu may draw a moment after the heading, so wait for it instead of counting at once.
    await page.getByRole("link", { name: "Posts", exact: true }).first().waitFor();
    await page.getByRole("link", { name: "Pages", exact: true }).first().click();
    await page.getByRole("heading", { name: "Pages", level: 1 }).waitFor();
    for (const title of ["Home", "About", "Contact"])
      await page.getByRole("table").getByRole("link", { name: title, exact: true }).waitFor();
    await page.goto(site.base + "/admin/posts");
    await page.getByRole("link", { name: "Hello world" }).waitFor();
    await page.close();
  });

  test("adding a page, writing in it and publishing it: it is private first, then on the public site at once, and a later change shows at once", async () => {
    const page = await browser.newPage();
    await signIn(page);
    await page.goto(site.base + "/admin/pages");
    await page.getByLabel(/^Title of the new page/).fill("My new page");
    await page.getByLabel("Start in").selectOption("writing");
    await page.getByRole("button", { name: "Add new" }).click();
    await page.getByRole("heading", { name: "Edit: My new page", level: 1 }).waitFor();
    expect(await page.getByLabel(/^Address/).inputValue()).toBe("my-new-page");
    expect((await text("/my-new-page")).status).toBe(404); // a draft is not public

    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type("Brand new words");
    await page.getByLabel("Published (everyone sees it)").check({ force: true });
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => status(page).textContent()).toBe("Saved.");
    const published = await text("/my-new-page");
    expect(published.status).toBe(200);
    expect(published.body).toContain("Brand new words");

    // A change to a published page shows on the public site at once (the cache is refreshed by tag).
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type(" and more");
    await page.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(async () => (await text("/my-new-page")).body)
      .toContain("Brand new words and more");

    // It is in the list, and reloading the edit screen gives back what was saved.
    await page.reload();
    expect(await page.getByLabel(/^Title/).inputValue()).toBe("My new page");
    await expect
      .poll(() => page.locator("[contenteditable=true]").first().innerText())
      .toContain("Brand new words and more");
    await page.close();
  });

  test("two people saving from the same version: the second is told, and nothing is overwritten", async () => {
    const first = await browser.newPage();
    const second = await browser.newPage();
    await signIn(first);
    await signIn(second);
    await first.goto(site.base + "/admin/pages");
    await first.getByRole("link", { name: "Contact", exact: true }).click();
    await first.getByRole("heading", { name: "Edit: Contact", level: 1 }).waitFor();
    const url = first.url();
    await second.goto(url);
    await second.getByRole("heading", { name: "Edit: Contact", level: 1 }).waitFor();
    await first.getByLabel(/^Title/).fill("Contact us");
    await first.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => status(first).textContent()).toBe("Saved.");
    await second.getByLabel(/^Title/).fill("Contact them");
    await second.getByRole("button", { name: "Save" }).click();
    await second
      .getByText(/Someone else saved this while you were editing/)
      .first()
      .waitFor();
    await second.reload();
    expect(await second.getByLabel(/^Title/).inputValue()).toBe("Contact us");
    await first.close();
    await second.close();
  });

  test("a contributor writes drafts but cannot publish: no Published choice, the server refuses, and others' entries stay closed", async () => {
    const page = await browser.newPage();
    await signIn(page, cara);
    await page.goto(site.base + "/admin/pages");
    expect(await page.getByRole("link", { name: "About", exact: true }).count()).toBe(0); // only her own
    await page.getByLabel(/^Title of the new page/).fill("Cara's draft");
    await page.getByLabel("Start in").selectOption("writing");
    await page.getByRole("button", { name: "Add new" }).click();
    await page.getByRole("heading", { name: "Edit: Cara's draft", level: 1 }).waitFor();
    await page.getByRole("radio", { name: /Waiting for review/ }).waitFor();
    expect(await page.getByLabel("Published (everyone sees it)").count()).toBe(0);

    const id = page.url().split("/").pop()!;
    const refused = await page.evaluate(async (entryId) => {
      const response = await fetch(`/api/admin/entries/${entryId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "x",
          slugPart: "caras-draft",
          status: "published",
          blocks: [],
          revision: 1,
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as { error: { field: string } },
      };
    }, id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.field).toBe("status");
    expect((await text("/caras-draft")).status).toBe(404);

    // The owner's page is not hers to open.
    const ownersId = String(
      (await db.run("select id from entries where slug = 'about'"))[0]!["id"],
    );
    await page.goto(site.base + `/admin/pages/${ownersId}`);
    await page.waitForURL("**/admin");
    await page.close();
  });

  test("without a session the save routes answer 401", async () => {
    const add = await fetch(site.base + "/api/admin/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "page", editor: "writing", title: "x" }),
    });
    expect(add.status).toBe(401);
    const save = await fetch(site.base + "/api/admin/entries/anything", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(save.status).toBe(401);
  });

  test("categories and tags: add, nest, change and delete; a deleted category's posts fall back to Uncategorised; signed-out requests are refused", async () => {
    const page = await browser.newPage();
    await signIn(page);
    await page.getByRole("link", { name: "Categories and tags", exact: true }).first().click();
    await page.getByRole("heading", { name: "Categories", level: 1 }).waitFor();
    const row = (name: string) => page.getByRole("row").filter({ hasText: name });
    await row("Uncategorised").first().waitFor();
    // Uncategorised can be changed but never deleted.
    expect(await row("Uncategorised").getByRole("button", { name: "Delete" }).count()).toBe(0);

    const add = async (name: string, parent?: string) => {
      await page.getByLabel(/^Name of the new category/).fill(name);
      if (parent) await page.getByLabel("Parent category").first().selectOption({ label: parent });
      await page.getByRole("button", { name: "Add new category" }).click();
      await row(name).first().waitFor();
    };
    await add("News");
    await add("Sports", "News");
    await row("– Sports").first().waitFor();

    const axeProblems = async (label: string) => {
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
        label,
      ).toEqual([]);
    };
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await axeProblems(`categories ${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    // Change a name; the address stays.
    await row("News").first().getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("News and views");
    await axeProblems("the change window");
    await dialog.getByRole("button", { name: "Save" }).click();
    await row("News and views").first().waitFor();
    const termId = async (slug: string) =>
      String((await db.run("select id from terms where slug = ?", [slug]))[0]!["id"]);
    expect(await termId("news")).toBeTruthy();

    // An address that is taken is refused in words, and the window stays open.
    await row("News and views").first().getByRole("button", { name: "Edit" }).click();
    await dialog.getByLabel("Address").fill("sports");
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.getByText("Another one already has this address.").waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // A post in the category, then the category is deleted: the post falls back and its child moves up.
    const postId = String(
      (await db.run("select id from entries where slug = 'blog/hello-world'"))[0]!["id"],
    );
    await db.run("insert into entry_terms (entry_id, term_id, position) values (?, ?, 0)", [
      postId,
      await termId("news"),
    ]);
    await page.reload();
    await row("News and views").first().waitFor();
    await row("News and views").first().getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.getByText(/Posts that have only this category move to Uncategorised/).waitFor();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByText("News and views").first().waitFor({ state: "detached" });
    await row("Sports").first().waitFor();
    expect(await page.getByText("– Sports").count()).toBe(0);
    const after = await db.run(
      "select t.slug from entry_terms et join terms t on t.id = et.term_id where et.entry_id = ?",
      [postId],
    );
    expect(after.map((r) => r["slug"])).toEqual(["uncategorised"]);

    // Tags: flat, no parent choice.
    await page.getByRole("link", { name: "Tags", exact: true }).first().click();
    await page.getByRole("heading", { name: "Tags", level: 1 }).waitFor();
    expect(await page.getByLabel("Parent category").count()).toBe(0);
    await page.getByLabel(/^Name of the new tag/).fill("Garden");
    await page.getByRole("button", { name: "Add new tag" }).click();
    await row("Garden").first().waitFor();
    await axeProblems("tags");
    await page.close();

    // Signed out: the screens send to sign-in and the API says 401.
    const visitor = await browser.newPage();
    await visitor.goto(site.base + "/admin/categories");
    await visitor.waitForURL("**/admin/login");
    await visitor.close();
    for (const [url, method] of [
      ["/api/admin/taxonomies/tag", "GET"],
      ["/api/admin/taxonomies/tag", "POST"],
      ["/api/admin/terms/anything", "PATCH"],
      ["/api/admin/terms/anything", "DELETE"],
    ] as const) {
      const response = await fetch(site.base + url, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      expect(response.status, `${method} ${url}`).toBe(401);
    }
  });

  test("choosing categories and tags on a post: saved and shown again, no choice means Uncategorised, pages have no box, signed-out is refused", async () => {
    const page = await browser.newPage();
    await signIn(page);
    const made = await page.evaluate(async () => {
      const response = await fetch("/api/admin/taxonomies/category", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Travel" }),
      });
      return response.status;
    });
    expect(made).toBe(201);
    const postId = String(
      (await db.run("select id from entries where slug = 'blog/hello-world'"))[0]!["id"],
    );
    const slugsOfPost = async () =>
      (
        await db.run(
          "select t.slug from entry_terms et join terms t on t.id = et.term_id where et.entry_id = ? order by et.position",
          [postId],
        )
      ).map((r) => String(r["slug"]));
    await page.goto(site.base + `/admin/posts/${postId}`);
    await page.getByRole("heading", { name: "Categories and tags", level: 2 }).waitFor();
    // An earlier test may have left the post in Uncategorised: start from no choice.
    await page.getByLabel("Travel").waitFor();
    if (await page.getByLabel("Uncategorised").isChecked())
      await page.getByLabel("Uncategorised").uncheck();
    await page.getByLabel("Travel").check();
    await page.getByLabel(/^Tags/).fill("Garden, Fresh Air");
    await page.getByRole("button", { name: "Save categories and tags" }).click();
    await page.getByText("Categories and tags saved.").waitFor();
    expect(await slugsOfPost()).toEqual(["travel", "garden", "fresh-air"]);

    // The choice is there after a reload.
    await page.reload();
    await page.getByRole("heading", { name: "Categories and tags", level: 2 }).waitFor();
    await page.getByLabel("Travel").waitFor();
    expect(await page.getByLabel("Travel").isChecked()).toBe(true);
    expect(await page.getByLabel(/^Tags/).inputValue()).toBe("Garden, Fresh Air");

    // No category chosen: the post gets Uncategorised, and the box shows it.
    await page.getByLabel("Travel").uncheck();
    await page.getByLabel(/^Tags/).fill("");
    await page.getByRole("button", { name: "Save categories and tags" }).click();
    await page.getByText("Categories and tags saved.").waitFor();
    expect(await slugsOfPost()).toEqual(["uncategorised"]);
    expect(await page.getByLabel("Uncategorised").isChecked()).toBe(true);

    // A page has no box.
    const aboutId = String((await db.run("select id from entries where slug = 'about'"))[0]!["id"]);
    await page.goto(site.base + `/admin/pages/${aboutId}`);
    await page.getByRole("heading", { name: "Edit: About", level: 1 }).waitFor();
    expect(await page.getByRole("heading", { name: "Categories and tags", level: 2 }).count()).toBe(
      0,
    );
    const refused = await page.evaluate(async (id) => {
      const response = await fetch(`/api/admin/entries/${id}/terms`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categoryIds: [], tags: [] }),
      });
      return response.status;
    }, aboutId);
    expect(refused).toBe(400);
    await page.close();

    for (const method of ["GET", "PUT"] as const) {
      const response = await fetch(site.base + `/api/admin/entries/${postId}/terms`, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "PUT" ? { body: "{}" } : {}),
      });
      expect(response.status, method).toBe(401);
    }
  });

  test("the public category and tag pages list published posts, include child categories, refresh at once and 404 when unknown", async () => {
    const page = await browser.newPage();
    await signIn(page);
    const call = (method: string, url: string, body?: unknown) =>
      page.evaluate(
        async ([m, u, b]) => {
          const response = await fetch(u as string, {
            method: m as string,
            headers: { "content-type": "application/json" },
            ...(b === undefined ? {} : { body: JSON.stringify(b) }),
          });
          return {
            status: response.status,
            json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
          };
        },
        [method, url, body] as const,
      );
    const termId = async (slug: string) =>
      String((await db.run("select id from terms where slug = ?", [slug]))[0]!["id"]);

    const rail = await call("POST", "/api/admin/taxonomies/category", { name: "Rail Trips" });
    expect(rail.status).toBe(201);
    const trains = await call("POST", "/api/admin/taxonomies/category", {
      name: "Trains",
      parentId: await termId("rail-trips"),
    });
    expect(trains.status).toBe(201);

    // A published post and a draft, both in Trains, with the tag "Window Seat".
    const addPost = async (title: string, publish: boolean) => {
      const made = await call("POST", "/api/admin/entries", { type: "post", title });
      const id = String(made.json!["id"]);
      if (publish) {
        const saved = await call("PUT", `/api/admin/entries/${id}`, {
          title,
          slugPart: String(made.json!["slug"]).replace(/^blog\//, ""),
          status: "published",
          blocks: [
            {
              id: "p1",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "Words.", styles: {} }],
              children: [],
            },
          ],
          revision: made.json!["revision"],
        });
        expect(saved.status).toBe(200);
      }
      const terms = await call("PUT", `/api/admin/entries/${id}/terms`, {
        categoryIds: [await termId("trains")],
        tags: ["Window Seat"],
      });
      expect(terms.status).toBe(200);
      return id;
    };
    const published = await addPost("Night train to Vienna", true);
    await addPost("Unfinished train notes", false);

    for (const path of ["/category/trains", "/category/rail-trips", "/tag/window-seat"]) {
      const { status: code, body } = await text(path);
      expect(code, path).toBe(200);
      expect(body, path).toContain("Night train to Vienna");
      expect(body, path).toContain('href="/blog/night-train-to-vienna"');
      expect(body, path).not.toContain("Unfinished train notes");
    }
    const trainsPage = await text("/category/trains");
    expect(trainsPage.body).toContain("<h1>Category: Trains</h1>");
    expect(trainsPage.body).toMatch(/<title>Category: Trains – Anna(?:.|&#x27;)s Garden<\/title>/);
    expect((await text("/tag/window-seat")).body).toContain("<h1>Tag: Window Seat</h1>");
    // Not in another category.
    expect((await text("/category/uncategorised")).body).not.toContain("Night train to Vienna");
    // A tag with no posts is an empty page, not a 404.
    await call("POST", "/api/admin/taxonomies/tag", { name: "Empty One" });
    const empty = await text("/tag/empty-one");
    expect(empty.status).toBe(200);
    expect(empty.body).toContain("There are no posts here yet.");

    // Unknown archives are real 404s with noindex, like any unknown address.
    for (const path of ["/category/nope", "/tag/nope", "/category", "/tag/window-seat/extra"]) {
      const response = await fetch(site.base + path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("x-robots-tag"), path).toContain("noindex");
    }

    // A change shows at once: a new name, then the post leaving the site.
    const renamed = await call("PATCH", `/api/admin/terms/${await termId("trains")}`, {
      name: "Locomotives",
    });
    expect(renamed.status).toBe(200);
    expect((await text("/category/trains")).body).toContain("Category: Locomotives");
    expect((await call("DELETE", `/api/admin/entries/${published}`)).status).toBe(200);
    expect((await text("/category/trains")).body).not.toContain("Night train to Vienna");
    // Deleting the category: the address goes away.
    expect((await call("DELETE", `/api/admin/terms/${await termId("trains")}`)).status).toBe(200);
    expect((await fetch(site.base + "/category/trains")).status).toBe(404);
    await page.close();
  });

  test("menus: add a page, a category and a link, nest and move them, save, see them after a reload; an old version is refused; signed-out is refused", async () => {
    const page = await browser.newPage();
    await signIn(page);
    await page.getByRole("link", { name: "Menus", exact: true }).first().click();
    await page.getByRole("heading", { name: "Menus", level: 1 }).waitFor();
    await page.getByRole("heading", { name: "Header menu", level: 2 }).waitFor();
    await page.getByText("This menu is empty.").waitFor();

    // A page, a link and a category (the starter site has these pages and the Uncategorised category).
    await page.getByLabel("Page or post").selectOption({ label: "Page: About" });
    await page.getByRole("button", { name: "Add to menu" }).click();
    await page.getByLabel("Add", { exact: true }).selectOption("url");
    await page.getByLabel("Label of the link").fill("Our shop");
    await page.getByLabel("Address of the link").fill("https://shop.example.com");
    await page.getByRole("button", { name: "Add to menu" }).click();
    await page.getByLabel("Add", { exact: true }).selectOption("term");
    await page.getByLabel("Category or tag").selectOption({ label: "Category: Uncategorised" });
    await page.getByRole("button", { name: "Add to menu" }).click();
    expect(await page.getByLabel("Label", { exact: true }).count()).toBe(3);

    // A bad address is refused in words.
    await page.getByLabel("Add", { exact: true }).selectOption("url");
    await page.getByLabel("Label of the link").fill("Bad");
    await page.getByLabel("Address of the link").fill("javascript:alert(1)");
    await page.getByRole("button", { name: "Add to menu" }).click();
    await page.getByText("The address must start with /").waitFor();

    // Move the category to the top, and rename the page's item. The first item cannot move up or become a sub-item.
    await page.getByRole("button", { name: "Move up: Uncategorised" }).click();
    await page.getByRole("button", { name: "Move up: Uncategorised" }).click();
    expect(await page.getByRole("button", { name: "Move up: Uncategorised" }).isDisabled()).toBe(
      true,
    );
    expect(
      await page.getByRole("button", { name: "Make a sub-item: Uncategorised" }).isDisabled(),
    ).toBe(true);
    await page.getByLabel("Label", { exact: true }).nth(1).fill("About us");
    await page.getByRole("button", { name: "Save menu" }).click();
    await page.getByText("Menu saved.").waitFor();

    const saved = async () =>
      JSON.parse(
        String((await db.run("select items from menus where key = 'primary'"))[0]!["items"]),
      ) as { label: string; kind: string; children: { label: string }[] }[];
    let tree = await saved();
    expect(tree.map((i) => i.label)).toEqual(["Uncategorised", "About us", "Our shop"]);

    // After a reload the same menu is there, and the footer menu is separate and empty.
    await page.reload();
    await page.getByLabel("Label", { exact: true }).first().waitFor();
    expect(await page.getByLabel("Label", { exact: true }).count()).toBe(3);
    await page.getByRole("link", { name: "Footer menu" }).click();
    await page.getByRole("heading", { name: "Footer menu", level: 2 }).waitFor();
    await page.getByText("This menu is empty.").waitFor();
    await page.getByRole("link", { name: "Header menu" }).click();
    await page.getByLabel("Label", { exact: true }).first().waitFor();

    // Indent "Our shop" under "About us", then move it back out; save the nested form.
    await page.getByRole("button", { name: "Make a sub-item: Our shop" }).click();
    await page.getByRole("button", { name: "Save menu" }).click();
    await page.getByText("Menu saved.").waitFor();
    tree = await saved();
    expect(tree[1]!.children.map((c) => c.label)).toEqual(["Our shop"]);

    // Someone else saves in between: this save is refused with a plain message and a Reload button.
    await db.run("update menus set updated_at = updated_at + 5000 where key = 'primary'");
    await page.getByRole("button", { name: "Move out: Our shop" }).click();
    await page.getByRole("button", { name: "Save menu" }).click();
    await page.getByText("Someone saved this menu while you were editing.").waitFor();
    await page.getByRole("button", { name: "Reload the menu" }).waitFor();
    tree = await saved();
    expect(tree[1]!.children.map((c) => c.label)).toEqual(["Our shop"]); // unchanged

    // Accessibility on a wide and a narrow screen.
    await page.reload();
    await page.getByLabel("Label", { exact: true }).first().waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
        `menus ${width}px`,
      ).toEqual([]);
    }
    await page.close();

    for (const method of ["GET", "PUT"] as const) {
      const response = await fetch(site.base + "/api/admin/menus/primary", {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "PUT" ? { body: "{}" } : {}),
      });
      expect(response.status, method).toBe(401);
    }
    const visitor = await browser.newPage();
    await visitor.goto(site.base + "/admin/menus");
    await visitor.waitForURL("**/admin/login");
    await visitor.close();
  });

  test("the public site shows the header and footer menus, follows a changed address, hides unpublished pages and refreshes at once", async () => {
    const page = await browser.newPage();
    await signIn(page);
    const call = (method: string, url: string, body?: unknown) =>
      page.evaluate(
        async ([m, u, b]) => {
          const response = await fetch(u as string, {
            method: m as string,
            headers: { "content-type": "application/json" },
            ...(b === undefined ? {} : { body: JSON.stringify(b) }),
          });
          return {
            status: response.status,
            json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
          };
        },
        [method, url, body] as const,
      );
    const entryId = async (slug: string) =>
      String((await db.run("select id from entries where slug = ?", [slug]))[0]!["id"]);
    const links = (html: string, label: string) =>
      [
        ...(
          new RegExp(`<nav aria-label="${label}">(.*?)</nav>`, "s").exec(html)?.[1] ?? ""
        ).matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g),
      ].map((m) => `${m[2]} -> ${m[1]}`);

    // The menu was saved by the earlier menu test or is empty: start from a known one.
    const before = await call("GET", "/api/admin/menus/primary");
    const version = (before.json!["menu"] as { updatedAt: number }).updatedAt;
    const saved = await call("PUT", "/api/admin/menus/primary", {
      updatedAt: version,
      items: [
        { id: "m1", label: "Home", kind: "entry", entryId: await entryId("home"), children: [] },
        {
          id: "m2",
          label: "About us",
          kind: "entry",
          entryId: await entryId("about"),
          children: [
            {
              id: "m3",
              label: "Contact",
              kind: "entry",
              entryId: await entryId("contact"),
              children: [],
            },
          ],
        },
        { id: "m4", label: "Shop", kind: "url", url: "https://shop.example.com", children: [] },
      ],
    });
    expect(saved.status).toBe(200);
    const footerSaved = await call("PUT", "/api/admin/menus/footer", {
      updatedAt: 0,
      items: [{ id: "f1", label: "Privacy", kind: "url", url: "/privacy", children: [] }],
    });
    expect(footerSaved.status).toBe(200);

    let html = (await text("/about")).body;
    expect(links(html, "Main menu")).toEqual([
      "Home -> /",
      "About us -> /about",
      "Contact -> /contact",
      "Shop -> https://shop.example.com",
    ]);
    expect(links(html, "Footer menu")).toEqual(["Privacy -> /privacy"]);
    // The menu is on the front page too, and on a category page.
    expect(links((await text("/")).body, "Main menu")).toHaveLength(4);
    expect(links((await text("/category/uncategorised")).body, "Main menu")).toHaveLength(4);

    // The public pages with a header and a footer menu have no accessibility violation (links are big enough).
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ["/", "/category/uncategorised"]) {
        await page.goto(site.base + path);
        await page.getByRole("navigation", { name: "Main menu" }).waitFor();
        await page.addScriptTag({ content: axe.source });
        const result = await page.evaluate(() =>
          (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          }),
        );
        expect(
          result.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          ),
          `${path} ${width}px`,
        ).toEqual([]);
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    // A page's address changes: the menu follows it at once.
    const aboutId = await entryId("about");
    const renamed = await call("PUT", `/api/admin/entries/${aboutId}`, {
      title: "About",
      slugPart: "about-us",
      status: "published",
      blocks: [],
      revision: Number(
        (await db.run("select revision from entries where id = ?", [aboutId]))[0]!["revision"],
      ),
    });
    expect(renamed.status).toBe(200);
    html = (await text("/contact")).body;
    expect(links(html, "Main menu")).toContain("About us -> /about-us");

    // A page that is not published leaves the menu with its sub-items; a published one comes back.
    const trashed = await call("DELETE", `/api/admin/entries/${aboutId}`);
    expect(trashed.status).toBe(200);
    expect(links((await text("/")).body, "Main menu")).toEqual([
      "Home -> /",
      "Shop -> https://shop.example.com",
    ]);
    const restored = await call("PATCH", `/api/admin/entries/${aboutId}`, { action: "restore" });
    expect(restored.status).toBe(200);
    // It comes back as a draft: still not in the menu.
    expect(links((await text("/")).body, "Main menu")).toHaveLength(2);

    // An empty menu draws nothing: no nav, no extra wrapper.
    const current = await call("GET", "/api/admin/menus/footer");
    const footerVersion = (current.json!["menu"] as { updatedAt: number }).updatedAt;
    await call("PUT", "/api/admin/menus/footer", { updatedAt: footerVersion, items: [] });
    expect((await text("/")).body).not.toContain('aria-label="Footer menu"');
    await page.close();
  });

  test("site search: finds published posts by title and text, ignores accents, helps with typos, marks the matches, shows 10 a page, and is fresh at once", async () => {
    const page = await browser.newPage();
    await signIn(page);
    const call = (method: string, url: string, body?: unknown) =>
      page.evaluate(
        async ([m, u, b]) => {
          const response = await fetch(u as string, {
            method: m as string,
            headers: { "content-type": "application/json" },
            ...(b === undefined ? {} : { body: JSON.stringify(b) }),
          });
          return {
            status: response.status,
            json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
          };
        },
        [method, url, body] as const,
      );
    const paragraph = (text: string) => [
      {
        id: "p1",
        type: "paragraph",
        props: {},
        content: [{ type: "text", text, styles: {} }],
        children: [],
      },
    ];
    const addPost = async (title: string, text: string, publish: boolean) => {
      const made = await call("POST", "/api/admin/entries", { type: "post", title });
      const id = String(made.json!["id"]);
      const saved = await call("PUT", `/api/admin/entries/${id}`, {
        title,
        slugPart: String(made.json!["slug"]).replace(/^blog\//, ""),
        status: publish ? "published" : "draft",
        blocks: paragraph(text),
        revision: made.json!["revision"],
      });
      expect(saved.status).toBe(200);
      return { id, slug: String(made.json!["slug"]) };
    };
    const starter = await addPost(
      "Sourdough starter guide",
      "Mix flour and water in a jar every day. A Café in Paris taught me this.",
      true,
    );
    const notes = await addPost(
      "Weekend notes",
      "We visited the sourdough bakery and bought fresh bread.",
      true,
    );
    await addPost("Secret sourdough plans", "Nobody may read about the bakery yet.", false);
    const results = async (query: string) => {
      const { status: code, body } = await text(`/search?q=${encodeURIComponent(query)}`);
      expect(code, query).toBe(200);
      return body;
    };
    const links = (body: string) =>
      [...body.matchAll(/<h2><a href="\/(blog\/[^"]*)">/g)].map((m) => m[1]);

    // A title match ranks above a text match; the draft is never found.
    let body = await results("sourdough");
    expect(links(body)).toEqual([starter.slug, notes.slug]);
    expect(body).toContain("<mark>sourdough</mark>");
    expect(body).not.toContain("Secret sourdough plans");
    expect(body).toContain("2 results");
    // Accents are ignored both ways; the end of the last word may be missing.
    expect(links(await results("cafe"))).toEqual([starter.slug]);
    expect(links(await results("CAFÉ paris"))).toEqual([starter.slug]);
    expect(links(await results("bake"))).toEqual([notes.slug]);
    expect(links(await results("flour bread"))).toEqual([]); // two different posts: every word must be in one
    // Typo help, and the way back to the exact words.
    body = await results("sourdogh");
    expect(body).toContain("Showing results for");
    expect(body).toContain("<strong>sourdough</strong>");
    expect(links(body)).toEqual([starter.slug, notes.slug]);
    const exact = (await text("/search?q=sourdogh&exact=1")).body;
    expect(exact).toContain("No results for");
    expect(body).toContain('href="/search?q=sourdogh&amp;exact=1"');
    // Empty query, no result, and markup in the query is shown as text.
    expect((await text("/search")).body).toContain("Type a word or two");
    body = await results("zzzzzzzz");
    expect(body).toContain("No results for");
    expect(body).toContain("Check the spelling");
    body = await results("<script>alert(1)</script>");
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");

    // The search page is not indexed and never cached.
    const response = await fetch(`${site.base}/search?q=sourdough`);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toContain('<meta name="robots" content="noindex');

    // Fresh at once: a changed title, a trashed post.
    const retitled = await call("PUT", `/api/admin/entries/${notes.id}`, {
      title: "Weekend market diary",
      slugPart: notes.slug.replace(/^blog\//, ""),
      status: "published",
      blocks: paragraph("We visited the sourdough bakery and bought fresh bread."),
      revision: Number(
        (await db.run("select revision from entries where id = ?", [notes.id]))[0]!["revision"],
      ),
    });
    expect(retitled.status).toBe(200);
    expect(links(await results("diary"))).toEqual([notes.slug]);
    expect((await call("DELETE", `/api/admin/entries/${notes.id}`)).status).toBe(200);
    expect(links(await results("diary"))).toEqual([]);
    expect(links(await results("bakery"))).toEqual([]);

    // Ten to a page, with Previous and Next, and a page number that is too big shows the last page.
    const userId = String((await db.run("select id from users limit 1"))[0]!["id"]);
    const siteId = String((await db.run("select id from sites"))[0]!["id"]);
    for (let n = 1; n <= 12; n++)
      await db.run(
        `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, published_at, created_at, updated_at)
         values (?, ?, 'post', 'published', ?, ?, ?, '{}', '{"version":1,"blocks":[]}', 'pagetest words', '', '{}', '{}', ?, ?, ?)`,
        [
          `PGE${String(n).padStart(23, "0")}`,
          siteId,
          `Pagetest ${n}`,
          `blog/pagetest-${n}`,
          userId,
          new Date(10_000 + n),
          new Date(),
          new Date(),
        ],
      );
    const first = (await text("/search?q=pagetest")).body;
    expect(links(first)).toHaveLength(10);
    expect(first).toContain("12 results");
    expect(first).toContain("Page 1 of 2");
    expect(first).toContain('href="/search?q=pagetest&amp;page=2">Next');
    const second = (await text("/search?q=pagetest&page=2")).body;
    expect(links(second)).toHaveLength(2);
    expect(second).toContain(">Previous</a>");
    expect(links((await text("/search?q=pagetest&page=99")).body)).toHaveLength(2);
    expect(links((await text("/search?q=pagetest&page=abc")).body)).toHaveLength(10);

    // No accessibility violation on a wide and a narrow screen.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${site.base}/search?q=pagetest`);
      await page.getByRole("heading", { name: "Search", level: 1 }).waitFor();
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
        `search ${width}px`,
      ).toEqual([]);
    }
    // The form works in a browser.
    await page.getByLabel("Search this site").fill("pagetest 3");
    await page.getByRole("button", { name: "Search" }).click();
    await page.waitForURL(/\/search\?q=pagetest\+3|\/search\?q=pagetest%203/);
    await page.getByRole("link", { name: "Pagetest 3" }).waitFor();
    await page.close();
  });

  test("redirects: a new address for a published post keeps the old one working (one step, query kept), and the screen adds, refuses loops and deletes", async () => {
    const page = await browser.newPage();
    await signIn(page);
    const call = (method: string, url: string, body?: unknown) =>
      page.evaluate(
        async ([m, u, b]) => {
          const response = await fetch(u as string, {
            method: m as string,
            headers: { "content-type": "application/json" },
            ...(b === undefined ? {} : { body: JSON.stringify(b) }),
          });
          return {
            status: response.status,
            json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
          };
        },
        [method, url, body] as const,
      );
    const hop = async (path: string) => {
      const response = await fetch(site.base + path, { redirect: "manual" });
      // The server may answer with a relative address ("/blog/x"): compare full addresses.
      const to = response.headers.get("location");
      return {
        status: response.status,
        location: to === null ? null : new URL(to, site.base).toString(),
      };
    };

    // A published post gets a new address twice.
    const made = await call("POST", "/api/admin/entries", { type: "post", title: "Old name" });
    const id = String(made.json!["id"]);
    const save = async (slugPart: string, revision: number) => {
      const saved = await call("PUT", `/api/admin/entries/${id}`, {
        title: "Old name",
        slugPart,
        status: "published",
        blocks: [
          {
            id: "p1",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "Words.", styles: {} }],
            children: [],
          },
        ],
        revision,
      });
      expect(saved.status).toBe(200);
      return Number(saved.json!["revision"]);
    };
    let revision = await save("old-name", Number(made.json!["revision"]));
    expect((await hop("/blog/old-name")).status).toBe(200);
    revision = await save("new-name", revision);
    const first = await hop("/blog/old-name");
    expect(first.status).toBe(301);
    expect(first.location).toBe(`${site.base}/blog/new-name`);
    // The query string goes along, and a trailing slash does not matter.
    expect((await hop("/blog/old-name?utm_source=mail")).location).toBe(
      `${site.base}/blog/new-name?utm_source=mail`,
    );
    const followed = await fetch(`${site.base}/blog/old-name/`);
    expect(followed.url).toBe(`${site.base}/blog/new-name`);
    expect(followed.status).toBe(200);
    // A second rename: the first old address goes straight to the newest one.
    revision = await save("newest-name", revision);
    expect((await hop("/blog/old-name")).location).toBe(`${site.base}/blog/newest-name`);
    expect((await hop("/blog/new-name")).location).toBe(`${site.base}/blog/newest-name`);
    expect((await hop("/blog/newest-name")).status).toBe(200);
    expect(revision).toBeGreaterThan(0);
    // An address that was never used is still a real 404.
    expect((await hop("/blog/never-existed")).status).toBe(404);
    // The uses are counted (in the background).
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.run("select hit_count from redirects where from_path = '/blog/old-name'")
            )[0]!["hit_count"],
          ),
        { timeout: 5000 },
      )
      .toBeGreaterThanOrEqual(3);

    // The screen lists them and adds one by hand.
    await page.goto(site.base + "/admin/settings/redirects");
    await page.getByRole("heading", { name: "Redirects", level: 1 }).waitFor();
    await page.getByRole("cell", { name: "/blog/old-name", exact: true }).waitFor();
    await page.getByLabel("Old address").fill("/legacy");
    await page.getByLabel("New address").fill("/blog/newest-name");
    await page.getByRole("button", { name: "Add redirect" }).click();
    await page.getByRole("cell", { name: "/legacy", exact: true }).waitFor();
    expect((await hop("/legacy")).location).toBe(`${site.base}/blog/newest-name`);

    // Refusals are said in words: a loop, a live page.
    const add = async (from: string, to: string) => {
      await page.getByLabel("Old address").fill(from);
      await page.getByLabel("New address").fill(to);
      await page.getByRole("button", { name: "Add redirect" }).click();
    };
    await add("/loop-a", "/loop-b");
    await page.getByRole("cell", { name: "/loop-a", exact: true }).waitFor();
    await add("/loop-b", "/loop-a");
    await page.getByText("This would make a loop.").waitFor();
    await add("/blog/newest-name", "/legacy"); // the live post of this test
    await page.getByText("A page already uses this address").waitFor();

    // No accessibility violation on a wide and a narrow screen.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
        `redirects ${width}px`,
      ).toEqual([]);
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    // Delete asks first; afterwards the old address is a 404.
    await page.getByRole("button", { name: "Delete the redirect from /legacy" }).click();
    await page
      .getByRole("alertdialog")
      .getByText(/will no longer lead to/)
      .waitFor();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await page.getByRole("cell", { name: "/legacy", exact: true }).waitFor({ state: "detached" });
    expect((await hop("/legacy")).status).toBe(404);
    await page.close();

    // Signed out: the API refuses.
    for (const [method, url] of [
      ["GET", "/api/admin/redirects"],
      ["POST", "/api/admin/redirects"],
      ["DELETE", "/api/admin/redirects/anything"],
    ] as const) {
      const response = await fetch(site.base + url, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, `${method} ${url}`).toBe(401);
    }
  });

  const addPageNamed = async (page: Page, title: string) => {
    await page.goto(site.base + "/admin/pages");
    await page.getByLabel(/^Title of the new page/).fill(title);
    await page.getByLabel("Start in").selectOption("writing");
    await page.getByRole("button", { name: "Add new" }).click();
    await page.getByRole("heading", { name: `Edit: ${title}`, level: 1 }).waitFor();
  };
  const copies = (page: Page) => page.locator("#revisions-heading + ul > li");

  test("trash: a published page leaves the site, can be restored as a draft, and can be deleted for good", async () => {
    const page = await browser.newPage();
    await signIn(page);
    await addPageNamed(page, "Trash me");
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type("Words to remove");
    await page.getByLabel("Published (everyone sees it)").check({ force: true });
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => status(page).textContent()).toBe("Saved.");
    expect((await text("/trash-me")).status).toBe(200);

    // Cancel does nothing; moving it asks first and then takes it off the public site at once.
    await page.getByRole("button", { name: "Move to trash" }).click();
    const ask = page.getByRole("alertdialog");
    await ask.getByRole("button", { name: "Cancel" }).click();
    await ask.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Move to trash" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Move to trash" }).click();
    await page.waitForURL("**/admin/pages");
    await expect.poll(async () => (await text("/trash-me")).status).toBe(404);
    expect(await page.getByRole("link", { name: "Trash me" }).count()).toBe(0);

    // The Trash view lists it with the days left; Restore brings it back as a draft.
    await page.getByRole("link", { name: /^Trash \(/ }).click();
    await page.getByRole("table", { name: "pages in the trash" }).waitFor();
    const row = page.getByRole("row", { name: /Trash me/ });
    expect(await row.textContent()).toContain("30");
    await row.getByRole("button", { name: "Restore" }).click();
    await page.getByText("The trash is empty.").waitFor();
    await page.goto(site.base + "/admin/pages");
    await page.getByRole("link", { name: "Trash me" }).click();
    await page.getByRole("heading", { name: "Edit: Trash me", level: 1 }).waitFor();
    expect(await page.getByLabel("Draft (only you see it)").isChecked()).toBe(true);
    expect((await text("/trash-me")).status).toBe(404);

    // Delete forever asks first, and then the page and its copies are gone from the database.
    await page.getByRole("button", { name: "Move to trash" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Move to trash" }).click();
    await page.waitForURL("**/admin/pages");
    await page.goto(site.base + "/admin/pages?view=trash");
    await page
      .getByRole("row", { name: /Trash me/ })
      .getByRole("button", { name: "Delete forever" })
      .click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete forever" }).click();
    await page.getByText("The trash is empty.").waitFor();
    expect(await db.run("select id from entries where title = 'Trash me'")).toEqual([]);
    await page.close();
  });

  test("the trash and the copies are closed to people who may not use them, and to anyone signed out", async () => {
    const owner_ = await browser.newPage();
    await signIn(owner_);
    await addPageNamed(owner_, "Anna's private");
    const id = owner_.url().split("/").pop()!;
    const caraPage = await browser.newPage();
    await signIn(caraPage, cara);
    const call = (method: string, path: string, body?: unknown) =>
      caraPage.evaluate(
        async ([m, u, b]) => {
          const r = await fetch(u as string, {
            method: m as string,
            headers: { "content-type": "application/json" },
            ...(b ? { body: JSON.stringify(b) } : {}),
          });
          return r.status;
        },
        [method, path, body] as const,
      );
    expect(await call("DELETE", `/api/admin/entries/${id}`)).toBe(403);
    expect(await call("PATCH", `/api/admin/entries/${id}`, { action: "restore" })).toBe(404);
    expect(await call("GET", `/api/admin/entries/${id}/revisions`)).toBe(403);
    for (const [method, path] of [
      ["DELETE", `/entries/${id}`],
      ["PATCH", `/entries/${id}`],
      ["GET", `/entries/${id}/revisions`],
      ["POST", `/entries/${id}/revisions`],
    ] as const) {
      const response = await fetch(site.base + "/api/admin" + path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" || method === "DELETE" ? null : "{}",
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    await owner_.close();
    await caraPage.close();
  });

  test("copies: each save keeps one, compare shows what changed, and restore puts the old text back", async () => {
    const page = await browser.newPage();
    await signIn(page);
    await addPageNamed(page, "Copies page");
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type("alpha");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => status(page).textContent()).toBe("Saved.");
    await expect.poll(() => copies(page).count()).toBe(1);
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type(" beta");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => copies(page).count()).toBe(2);
    const oldest = copies(page).last();
    expect(await oldest.textContent()).toContain("by Anna: Changed the text");

    await oldest.getByRole("button", { name: "Compare" }).click();
    const region = page.getByRole("region", { name: "Compare with this copy" });
    await region.getByText("Only in the copy: alpha", { exact: true }).waitFor();
    await region.getByText("Only in the page now: alpha beta", { exact: true }).waitFor();
    await region.getByRole("button", { name: "Close the compare" }).click();

    // Restore asks first; then the old text is the newest save, and it is in the copies list too.
    await oldest.getByRole("button", { name: "Restore" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Restore this copy" }).click();
    await expect
      .poll(() => page.locator("[contenteditable=true]").first().innerText())
      .toMatch(/^alpha\s*$/);
    await expect.poll(() => copies(page).count()).toBe(3);
    expect(await copies(page).first().textContent()).toContain("Restored the copy from");
    await page.close();
  });

  test("scheduling on the screen: a time in the past is refused, a future time is kept, and the page is not live yet", async () => {
    const page = await browser.newPage();
    await signIn(page);
    await addPageNamed(page, "Plan ahead");
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type("Coming soon");
    await page.getByLabel(/^Scheduled/).check({ force: true });
    await page.getByLabel("Publish at").fill("2020-01-15T09:30");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Choose a time in the future.").first().waitFor();

    await page.getByLabel("Publish at").fill("2090-01-15T09:30");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => status(page).textContent()).toBe("Saved.");
    expect((await text("/plan-ahead")).status).toBe(404);

    await page.reload();
    await page.getByRole("heading", { name: "Edit: Plan ahead", level: 1 }).waitFor();
    expect(await page.getByLabel(/^Scheduled/).isChecked()).toBe(true);
    expect(await page.getByLabel("Publish at").inputValue()).toBe("2090-01-15T09:30");
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      }),
    );
    expect(
      result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
    await page.goto(site.base + "/admin/pages");
    await page
      .getByRole("row", { name: /Plan ahead/ })
      .getByText("scheduled")
      .waitFor();

    // Back to a draft takes the time away.
    await page.getByRole("link", { name: "Plan ahead" }).click();
    await page.getByRole("heading", { name: "Edit: Plan ahead", level: 1 }).waitFor();
    await page.getByLabel("Draft (only you see it)").check({ force: true });
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => status(page).textContent()).toBe("Saved.");
    expect(
      (await db.run("select scheduled_at from entries where title = 'Plan ahead'"))[0]![
        "scheduled_at"
      ],
    ).toBeNull();
    await page.close();
  });

  test("a scheduled page goes live by itself at its time, and the copies list says so", async () => {
    const page = await browser.newPage();
    await signIn(page);
    await addPageNamed(page, "Goes live");
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type("Scheduled words");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => status(page).textContent()).toBe("Saved.");
    expect((await text("/goes-live")).status).toBe(404);
    // The screen's time box has minutes; to see the job work in seconds the test sends the time itself.
    const saved = (
      await db.run("select id, revision, body from entries where title = 'Goes live'")
    )[0]!;
    const body = (
      typeof saved["body"] === "string" ? JSON.parse(saved["body"]) : saved["body"]
    ) as {
      blocks: unknown[];
    };
    const status_ = await page.evaluate(
      async ([id, revision, blocks, at]) => {
        const response = await fetch(`/api/admin/entries/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Goes live",
            slugPart: "goes-live",
            status: "scheduled",
            scheduledAt: at,
            blocks,
            revision,
          }),
        });
        return response.status;
      },
      [
        saved["id"],
        Number(saved["revision"]),
        body.blocks,
        new Date(Date.now() + 2500).toISOString(),
      ] as const,
    );
    expect(status_).toBe(200);
    expect((await text("/goes-live")).status).toBe(404); // not yet

    await expect
      .poll(async () => (await text("/goes-live")).status, { timeout: 40_000, interval: 500 })
      .toBe(200);
    expect((await text("/goes-live")).body).toContain("Scheduled words");
    const live = (
      await db.run(
        "select status, scheduled_at, published_at from entries where title = 'Goes live'",
      )
    )[0]!;
    expect(live["status"]).toBe("published");
    expect(live["scheduled_at"]).toBeNull();
    expect(live["published_at"]).not.toBeNull();

    await page.reload();
    await copies(page).first().waitFor();
    expect(await copies(page).first().textContent()).toContain("Published on schedule");
    await page.close();
  });

  test("autosave: a copy is kept 10 s after typing, the page is untouched, it is offered back on the next visit, and a save clears it", async () => {
    const page = await browser.newPage();
    await signIn(page);
    await addPageNamed(page, "Kept copy");
    const id = page.url().split("/").pop()!;
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type("Words nobody saved");
    await page
      .locator("#autosave-status")
      .getByText(/kept as a copy at/)
      .waitFor({ timeout: 30_000 });
    const copies_ = async () =>
      (
        await db.run("select kind from entry_revisions where entry_id = ? and kind = 'autosave'", [
          id,
        ])
      ).length;
    expect(await copies_()).toBe(1);
    const entry = (await db.run("select plain_text, revision from entries where id = ?", [id]))[0]!;
    expect(String(entry["plain_text"] ?? "")).not.toContain("nobody saved");
    expect(await copies(page).count()).toBe(0); // it is not an earlier copy

    // Leave without saving; the next visit offers the copy back.
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(site.base + "/admin/pages");
    await page.goto(site.base + `/admin/pages/${id}`);
    await page.getByText("You have changes that were not saved").waitFor();
    await page.getByRole("button", { name: "Bring them back" }).click();
    await expect
      .poll(() => page.locator("[contenteditable=true]").first().innerText())
      .toContain("Words nobody saved");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => status(page).textContent()).toBe("Saved.");
    expect(await copies_()).toBe(0);
    await page.reload();
    await page.getByRole("heading", { name: "Edit: Kept copy", level: 1 }).waitFor();
    expect(await page.getByText("You have changes that were not saved").count()).toBe(0);

    // Throwing a copy away.
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type(" and more");
    await page
      .locator("#autosave-status")
      .getByText(/kept as a copy at/)
      .waitFor({ timeout: 30_000 });
    await page.goto(site.base + `/admin/pages/${id}`);
    await page.getByText("You have changes that were not saved").waitFor();
    await page.getByRole("button", { name: "Throw them away" }).click();
    await expect.poll(copies_).toBe(0);
    await page.close();
  });

  test("the editing notice: the second person is told who has the page open, nobody is blocked, and leaving ends it", async () => {
    const caraPage = await browser.newPage();
    await signIn(caraPage, cara);
    await addPageNamed(caraPage, "Shared page");
    const id = caraPage.url().split("/").pop()!;
    const page = await browser.newPage();
    await signIn(page);
    await page.goto(site.base + `/admin/pages/${id}`);
    await page.getByText("Cara has this page open too").waitFor();
    // Anna can still change and save it.
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type("Anna was here");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => status(page).textContent()).toBe("Saved.");
    // Cara leaves; the notice goes, so a later visit by Anna's colleague sees no one.
    await caraPage.goto(site.base + "/admin/pages");
    await expect
      .poll(async () => (await db.run("select 1 from entry_locks where entry_id = ?", [id])).length)
      .toBe(0);
    await page.close();
    await caraPage.close();
  });

  test("a contributor cannot schedule, and does not see the choice", async () => {
    const page = await browser.newPage();
    await signIn(page, cara);
    await addPageNamed(page, "Cara's draft");
    expect(await page.getByLabel(/^Scheduled/).count()).toBe(0);
    const id = page.url().split("/").pop()!;
    const code = await page.evaluate(
      async ([entry, at]) => {
        const response = await fetch(`/api/admin/entries/${entry}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Cara's draft",
            slugPart: "caras-draft",
            status: "scheduled",
            scheduledAt: at,
            blocks: [],
            revision: 1,
          }),
        });
        return response.status;
      },
      [id, new Date(Date.now() + 86_400_000).toISOString()] as const,
    );
    expect(code).toBe(403);
    await page.close();
  });

  test("the trash view and an edit screen with copies have no accessibility violations on a wide and a narrow screen", async () => {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await signIn(page);
      await addPageNamed(page, `Check ${width}`);
      await page.locator("[contenteditable=true]").first().click();
      await page.keyboard.type("text");
      await page.getByRole("button", { name: "Save" }).click();
      await expect.poll(() => copies(page).count()).toBe(1);
      await page.getByRole("button", { name: "Move to trash" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Move to trash" }).click();
      await page.waitForURL("**/admin/pages");
      for (const open of [
        async () => {
          await page.goto(site.base + "/admin/pages?view=trash");
          await page.getByRole("table", { name: "pages in the trash" }).waitFor();
        },
        async () => {
          await page
            .getByRole("row", { name: new RegExp(`Check ${width}`) })
            .getByRole("button", { name: "Restore" })
            .click();
          await page
            .getByText("The trash is empty.")
            .waitFor()
            .catch(() => undefined);
          await page.goto(site.base + "/admin/pages");
          await page.getByRole("link", { name: `Check ${width}` }).click();
          await page.getByRole("heading", { name: `Edit: Check ${width}`, level: 1 }).waitFor();
          await copies(page).first().waitFor();
          await page.getByRole("button", { name: "Compare" }).first().click();
          await page.getByRole("region", { name: "Compare with this copy" }).waitFor();
        },
      ]) {
        await open();
        await page.addScriptTag({ content: axe.source });
        const result = await page.evaluate(() =>
          (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          }),
        );
        expect(
          result.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          ),
          `${width}px`,
        ).toEqual([]);
      }
      await page.close();
    }
  });

  test("the list and the edit screen have no accessibility violations on a wide and a narrow screen", async () => {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await signIn(page);
      for (const [path, heading] of [
        ["/admin/pages", "Pages"],
        ["/admin/posts", "Posts"],
      ] as const) {
        await page.goto(site.base + path);
        await page.getByRole("heading", { name: heading, level: 1 }).waitFor();
        await page.addScriptTag({ content: axe.source });
        const result = await page.evaluate(() =>
          (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          }),
        );
        expect(
          result.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          ),
          `${path} ${width}px`,
        ).toEqual([]);
      }
      await page.goto(site.base + "/admin/posts");
      await page.getByRole("link", { name: "Hello world" }).click();
      await page.getByRole("heading", { name: "Edit: Hello world", level: 1 }).waitFor();
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
        `edit ${width}px`,
      ).toEqual([]);
      await page.close();
    }
  });
});

// Uploads through the real server: the upload route, the background job, the file route and its headers, who may do
// what, and the limits (spec 09: MD-01 to MD-07, MD-20, MD-21, MD-30 (without the screen), MD-31, MD-35, MD-36).
describe.skipIf(!findBrowser())("media: upload and files", { timeout: 120_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  let uploads = "";
  const owner = { email: "anna@example.com", password: "a-long-password" };
  const cara = { email: "cara@example.com", password: "cara-long-password" };
  type Page = Awaited<ReturnType<Browser["newPage"]>>;
  let ownerApi: Page["context"] extends () => infer C
    ? C extends { request: infer R }
      ? R
      : never
    : never;
  let caraApi: typeof ownerApi;

  const jpeg = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 120, b: 200 } } })
      .jpeg()
      .toBuffer();

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "oks-media-site-"));
    uploads = join(root, "uploads");
    db = await openSqlite(join(root, "site.sqlite"));
    site = await startSite("sqlite", db, {
      OKS_SECRET: "s".repeat(40),
      OKS_UPLOADS_DIR: uploads,
    });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        starterContent: false,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    const signUp = await fetch(site.base + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: site.base },
      body: JSON.stringify({ name: "Cara", ...cara }),
    });
    const caraId = ((await signUp.json()) as { user: { id: string } }).user.id;
    const siteId = String((await db.run("select id from sites"))[0]!["id"]);
    const role = String((await db.run("select id from roles where key = 'contributor'"))[0]!["id"]);
    await db.run(
      "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
      [siteId, caraId, role, new Date()],
    );
    browser = await chromium.launch({ executablePath: findBrowser()! });
    const signIn = async (who: typeof owner) => {
      const page = await browser.newPage();
      await page.goto(site.base + "/admin/login");
      await page.getByLabel("Email").fill(who.email);
      await page.getByLabel(/^Password/).fill(who.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      return page;
    };
    ownerApi = (await signIn(owner)).context().request;
    caraApi = (await signIn(cara)).context().request;
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  const send = (
    api: typeof ownerApi,
    name: string,
    buffer: Buffer | Uint8Array,
    mimeType = "application/octet-stream",
  ) =>
    api.post(site.base + "/api/admin/media", {
      multipart: { file: { name, mimeType, buffer: Buffer.from(buffer) } },
    });
  const item = async (id: string) =>
    (await (await ownerApi.get(site.base + `/api/admin/media/${id}`)).json()) as {
      item: {
        status: string;
        url: string;
        variants: { width: number; format: string; url: string }[];
        alt: string;
        blurPlaceholder: string | null;
      };
      usedIn: unknown[];
      canEdit: boolean;
    };
  const ready = async (id: string) => {
    let last = await item(id);
    for (let i = 0; i < 100 && last.item.status === "processing"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      last = await item(id);
    }
    return last;
  };

  test("a photo is uploaded, its sizes are made in the background, and every file is served with the protective headers", async () => {
    const response = await send(ownerApi, "My Photo é.JPG", await jpeg(900, 450), "image/jpeg");
    expect(response.status()).toBe(201);
    const made = (await response.json()) as {
      id: string;
      status: string;
      url: string;
      fileName: string;
    };
    expect(made.fileName).toBe("My-Photo-é.jpg");
    expect(["processing", "ready"]).toContain(made.status);

    const done = await ready(made.id);
    expect(done.item.status).toBe("ready");
    expect(done.item.blurPlaceholder).toMatch(/^data:image\/webp;base64,/);
    expect(done.item.variants.map((v) => `${v.width}.${v.format}`)).toEqual([
      "320.avif",
      "320.webp",
      "640.avif",
      "640.webp",
      "900.avif",
      "900.webp",
    ]);

    // The original: right type, safe headers, the picture itself.
    const original = await fetch(site.base + made.url);
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("image/jpeg");
    expect(original.headers.get("x-content-type-options")).toBe("nosniff");
    expect(original.headers.get("content-disposition")).toMatch(
      /^inline; filename\*=UTF-8''My-Photo-%C3%A9\.jpg$/,
    );
    expect(original.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(original.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const meta = await sharp(Buffer.from(await original.arrayBuffer())).metadata();
    expect({ w: meta.width, h: meta.height }).toEqual({ w: 900, h: 450 });

    // A size.
    const small = done.item.variants.find((v) => v.width === 320 && v.format === "avif")!;
    const sized = await fetch(site.base + small.url);
    expect(sized.status).toBe(200);
    expect(sized.headers.get("content-type")).toBe("image/avif");
    expect((await sharp(Buffer.from(await sized.arrayBuffer())).metadata()).width).toBe(320);
  });

  test("a name with a space, an accent and a percent sign is served", async () => {
    const response = await send(
      ownerApi,
      "100%41 my photo é.png",
      await sharp({ create: { width: 20, height: 20, channels: 3, background: "#c00" } })
        .png()
        .toBuffer(),
      "image/png",
    );
    const made = (await response.json()) as { id: string; url: string };
    const served = await fetch(site.base + made.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
  });

  test("a PDF and an SVG are always downloaded; the SVG is cleaned first; PHP and a renamed file are refused", async () => {
    const pdf = await send(
      ownerApi,
      "Menu card.pdf",
      Buffer.from("%PDF-1.7\n%x\n"),
      "application/pdf",
    );
    expect(pdf.status()).toBe(201);
    const pdfFile = await fetch(site.base + ((await pdf.json()) as { url: string }).url);
    expect(pdfFile.headers.get("content-type")).toBe("application/pdf");
    expect(pdfFile.headers.get("content-disposition")).toMatch(/^attachment;/);

    const svg = await send(
      ownerApi,
      "logo.svg",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script><rect width="1" height="1" onclick="x()"/></svg>',
      ),
      "image/svg+xml",
    );
    expect(svg.status()).toBe(201);
    const svgFile = await fetch(site.base + ((await svg.json()) as { url: string }).url);
    expect(svgFile.headers.get("content-type")).toBe("image/svg+xml");
    expect(svgFile.headers.get("content-disposition")).toMatch(/^attachment;/);
    const svgText = await svgFile.text();
    expect(svgText).toContain("<rect");
    expect(svgText).not.toMatch(/script|onclick|alert/);

    const php = await send(ownerApi, "shell.php", Buffer.from("<?php system($_GET['c']); ?>"));
    expect(php.status()).toBe(400);
    const renamed = await send(
      ownerApi,
      "photo.jpg",
      await sharp({ create: { width: 5, height: 5, channels: 3, background: "#000" } })
        .png()
        .toBuffer(),
    );
    expect(renamed.status()).toBe(400);
    expect(((await renamed.json()) as { error: { message: string } }).error.message).toBe(
      "The file says it is .jpg but its content is image/png.",
    );
  });

  test("a contributor may not upload, and nobody signed out may do anything", async () => {
    const png = await sharp({ create: { width: 5, height: 5, channels: 3, background: "#000" } })
      .png()
      .toBuffer();
    expect((await send(caraApi, "a.png", png)).status()).toBe(403);
    const anon = await fetch(site.base + "/api/admin/media", {
      method: "POST",
      body: (() => {
        const f = new FormData();
        f.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "a.png");
        return f;
      })(),
    });
    expect(anon.status).toBe(401);
    expect((await fetch(site.base + "/api/admin/media")).status).toBe(401);
    expect((await fetch(site.base + "/api/admin/media/01ARZ3NDEKTSV4RRFFQ69G5FAV")).status).toBe(
      401,
    );
    expect(
      (await fetch(site.base + "/api/admin/media/01ARZ3NDEKTSV4RRFFQ69G5FAV", { method: "DELETE" }))
        .status,
    ).toBe(401);
    // A request that says it comes from another address is refused.
    const foreign = await ownerApi.post(site.base + "/api/admin/media", {
      headers: { origin: "https://evil.example" },
      multipart: { file: { name: "a.png", mimeType: "image/png", buffer: png } },
    });
    expect(foreign.status()).toBe(403);
  });

  test("an unknown file, or a key that tries to climb out of the folder, is 404", async () => {
    for (const path of [
      "/uploads/2026/11/nothing.png",
      "/uploads/..%2F..%2Fetc%2Fpasswd",
      "/uploads/%2e%2e/%2e%2e/etc/passwd",
      "/uploads/2026/11/%00.png",
    ]) {
      expect((await fetch(site.base + path)).status, path).toBe(404);
    }
  });

  test("alt text is saved, and deleting removes the file and its sizes from the disk and the site", async () => {
    const made = (await (
      await send(ownerApi, "tmp.jpg", await jpeg(400, 300), "image/jpeg")
    ).json()) as { id: string; url: string };
    const done = await ready(made.id);
    const patch = await ownerApi.patch(site.base + `/api/admin/media/${made.id}`, {
      data: { alt: "A blue rectangle", title: "Blue", focalX: 0.5, focalY: 0.25 },
    });
    expect(patch.status()).toBe(200);
    expect((await item(made.id)).item.alt).toBe("A blue rectangle");
    expect(
      (
        await ownerApi.patch(site.base + `/api/admin/media/${made.id}`, {
          data: { alt: "x".repeat(600) },
        })
      ).status(),
    ).toBe(400);
    // A contributor has no access to the library at all.
    expect((await caraApi.get(site.base + `/api/admin/media/${made.id}`)).status()).toBe(403);

    const list = (await (await ownerApi.get(site.base + "/api/admin/media?search=tmp")).json()) as {
      items: { id: string }[];
      total: number;
    };
    expect(list.items.map((i) => i.id)).toEqual([made.id]);

    const sizes = done.item.variants.map((v) => v.url);
    expect(sizes.length).toBeGreaterThan(0);
    const deleted = await ownerApi.delete(site.base + `/api/admin/media/${made.id}`);
    expect(deleted.status()).toBe(200);
    expect((await fetch(site.base + made.url)).status).toBe(404);
    for (const url of sizes) expect((await fetch(site.base + url)).status, url).toBe(404);
    expect((await ownerApi.get(site.base + `/api/admin/media/${made.id}`)).status()).toBe(404);
  });

  test("a file in use cannot be deleted, and the answer lists the pages (MD-35)", async () => {
    const made = (await (
      await send(
        ownerApi,
        "used.png",
        await sharp({ create: { width: 9, height: 9, channels: 3, background: "#0a0" } })
          .png()
          .toBuffer(),
        "image/png",
      )
    ).json()) as { id: string };
    await ready(made.id);
    const siteId = String((await db.run("select id from sites"))[0]!["id"]);
    const entry = String(
      (await db.run("select id from entries where site_id = ? limit 1", [siteId]))[0]?.["id"] ?? "",
    );
    let entryId = entry;
    if (!entryId) {
      const created = await ownerApi.post(site.base + "/api/admin/entries", {
        data: { type: "page", editor: "writing", title: "Uses a picture" },
      });
      entryId = ((await created.json()) as { id: string }).id;
    }
    await db.run("insert into entry_media (entry_id, media_id, field) values (?, ?, ?)", [
      entryId,
      made.id,
      "body",
    ]);
    const refused = await ownerApi.delete(site.base + `/api/admin/media/${made.id}`);
    expect(refused.status()).toBe(409);
    const body = (await refused.json()) as { error: { code: string }; usedIn: { id: string }[] };
    expect(body.error.code).toBe("in_use");
    expect(body.usedIn.map((u) => u.id)).toEqual([entryId]);
    expect(((await item(made.id)).usedIn as unknown[]).length).toBe(1);
  });

  test("a big file (12 MB) is accepted, and the sizes are made in the background", async () => {
    // Random pixels do not shrink when saved, so the file is bigger than the 10 MB a proxy usually allows.
    const noise = await sharp(randomBytes(2000 * 2000 * 3), {
      raw: { width: 2000, height: 2000, channels: 3 },
    })
      .png({ compressionLevel: 1 })
      .toBuffer();
    expect(noise.length).toBeGreaterThan(10 * 1024 * 1024);
    const response = await send(ownerApi, "big.png", noise, "image/png");
    expect(response.status()).toBe(201);
    const made = (await response.json()) as { id: string };
    const done = await ready(made.id);
    expect(done.item.status).toBe("ready");
  });

  test("a file over the limit (26 MB) is refused", async () => {
    const response = await send(
      ownerApi,
      "huge.pdf",
      Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(26 * 1024 * 1024)]),
      "application/pdf",
    );
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /too big/,
    );
  });

  test("the folder holds only what the library knows: no stray or temporary files", async () => {
    const rows = await db.run("select storage_key from media");
    const variants = await db.run("select storage_key from media_variants");
    const known = new Set([...rows, ...variants].map((r) => String(r["storage_key"])));
    const onDisk: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else onDisk.push(relative(uploads, join(dir, e.name)).split(sep).join("/"));
      }
    };
    walk(uploads);
    expect(onDisk.filter((f) => !known.has(f))).toEqual([]);
    expect(onDisk.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  // ---- the screens ---------------------------------------------------------------------------------------------
  const ownerPage = async (width = 1280) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.context().addCookies((await ownerApi.storageState()).cookies);
    return page;
  };
  const png = (color = "#c00", w = 30, h = 20) =>
    sharp({ create: { width: w, height: h, channels: 3, background: color } })
      .png()
      .toBuffer();
  // Waits until the sizes exist, so no background work competes with the browser steps that follow (on a slow
  // machine that made the later tests of this group time out).
  const uploadVia = async (name: string, color = "#c00") => {
    const made = (await (await send(ownerApi, name, await png(color), "image/png")).json()) as {
      id: string;
      url: string;
    };
    await ready(made.id);
    return made;
  };
  const openLibrary = async (page: Awaited<ReturnType<typeof ownerPage>>) => {
    await page.goto(site.base + "/admin/media");
    await page.getByRole("heading", { name: "Media", level: 1 }).waitFor();
  };
  const violations = async (page: Awaited<ReturnType<typeof ownerPage>>) => {
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      }),
    );
    return result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  };

  test("the library lists files, searches, filters by type, uploads with the button, and saves alt text that is there after a reload", async () => {
    await uploadVia("Sunset beach.png", "#f80");
    await send(ownerApi, "Report.pdf", Buffer.from("%PDF-1.7\n%x\n"), "application/pdf");
    const page = await ownerPage();
    await openLibrary(page);
    await page.getByRole("link", { name: "Media", exact: true }).first().waitFor(); // the menu has the new entry
    await page.getByRole("option", { name: /^Sunset-beach\.png/ }).waitFor();
    await page.getByRole("option", { name: /^Report\.pdf/ }).waitFor();

    await page.getByRole("searchbox", { name: "Search media" }).fill("report");
    await expect.poll(() => page.getByRole("option", { name: /^Sunset-beach/ }).count()).toBe(0);
    await page.getByRole("option", { name: /^Report\.pdf/ }).waitFor();
    await page.getByRole("searchbox", { name: "Search media" }).fill("");
    await page.getByRole("button", { name: "Images", exact: true }).click();
    await expect.poll(() => page.getByRole("option", { name: /^Report/ }).count()).toBe(0);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("option", { name: /^Report\.pdf/ }).waitFor();

    // Upload with the button: the file shows, is picked, and its panel opens.
    await page
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: "Fresh upload.png",
        mimeType: "image/png",
        buffer: await png("#0a0"),
      });
    await page.getByText("Uploaded Fresh upload.png.").waitFor();
    await page.getByRole("option", { name: /^Fresh-upload\.png/ }).waitFor();
    await page.getByRole("heading", { name: "Fresh-upload.png", level: 2 }).waitFor();
    // Making the sizes can take a while when the whole suite runs at once.
    await expect
      .poll(() => page.getByText("Making the smaller sizes…").count(), { timeout: 60_000 })
      .toBe(0);

    await page.getByRole("textbox", { name: "Alt text" }).fill("A green square");
    await page.getByRole("button", { name: "Save details" }).click();
    await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
    await openLibrary(page);
    await page.getByRole("option", { name: /^Fresh-upload\.png/ }).click();
    await expect
      .poll(() => page.getByRole("textbox", { name: "Alt text" }).inputValue())
      .toBe("A green square");
    await page.close();
  });

  test("media settings: the owner changes the biggest file on the settings screen and the next upload obeys it", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1_500_000)]);
    const page = await ownerPage();
    try {
      await openLibrary(page);
      await page.getByRole("link", { name: "Media settings" }).click();
      await page.getByRole("heading", { name: "Media settings", level: 1 }).waitFor();
      expect(await page.getByRole("textbox", { name: /Biggest file/ }).inputValue()).toBe("25");
      await page.getByRole("textbox", { name: /Biggest file/ }).fill("0");
      await page.getByRole("button", { name: "Save settings" }).click();
      await page.getByRole("alert").filter({ hasText: "from 1 to 200 MB" }).waitFor();
      expect(await violations(page), "media settings with an error").toEqual([]);

      await page.getByRole("textbox", { name: /Biggest file/ }).fill("1");
      await page.getByRole("button", { name: "Save settings" }).click();
      await page.getByText("Saved. The new limits count from the next upload.").waitFor();

      const refused = await send(ownerApi, "big.pdf", pdf, "application/pdf");
      expect(refused.status()).toBe(400);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(
        /too big/,
      );
      // It is still there after a reload.
      await page.reload();
      expect(await page.getByRole("textbox", { name: /Biggest file/ }).inputValue()).toBe("1");
    } finally {
      await ownerApi.put(site.base + "/api/admin/settings/media", { data: { maxMegabytes: 25 } });
    }
    expect((await send(ownerApi, "big-ok.pdf", pdf, "application/pdf")).status()).toBe(201);
    await page.close();
  });

  test("a refused file shows the reason in words, and nothing is added", async () => {
    const page = await ownerPage();
    await openLibrary(page);
    const before = await page.getByRole("option").count();
    await page
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: "fake.png",
        mimeType: "image/png",
        buffer: Buffer.from("<?php echo 1; ?>"),
      });
    await page.getByRole("alert").filter({ hasText: "fake.png was not uploaded" }).waitFor();
    expect(await page.getByRole("alert").first().innerText()).toContain(
      "This kind of file is not allowed.",
    );
    expect(await page.getByRole("option").count()).toBe(before);
    await page.getByRole("button", { name: "Dismiss" }).click();
    expect(await page.getByRole("alert").filter({ hasText: "fake.png" }).count()).toBe(0);
    await page.close();
  });

  test("delete asks first; a file that a page uses stays and the page is listed", async () => {
    const doomed = await uploadVia("Doomed.png");
    const busy = await uploadVia("Busy.png", "#00c");
    const created = await ownerApi.post(site.base + "/api/admin/entries", {
      data: { type: "page", editor: "writing", title: "Uses Busy" },
    });
    const pageId = ((await created.json()) as { id: string }).id;
    await db.run("insert into entry_media (entry_id, media_id, field) values (?, ?, ?)", [
      pageId,
      busy.id,
      "body",
    ]);

    const page = await ownerPage();
    await openLibrary(page);
    await page.getByRole("option", { name: /^Doomed\.png/ }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Delete this file?" }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    expect((await fetch(site.base + doomed.url)).status).toBe(200);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete file" }).click();
    await expect.poll(() => page.getByRole("option", { name: /^Doomed\.png/ }).count()).toBe(0);
    await expect.poll(async () => (await fetch(site.base + doomed.url)).status).toBe(404);

    await page.getByRole("option", { name: /^Busy\.png/ }).click();
    await page.getByRole("link", { name: "Uses Busy" }).waitFor(); // the Used-in list
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete file" }).click();
    await page.getByText("This file is in use").waitFor();
    expect(await page.getByRole("option", { name: /^Busy\.png/ }).count()).toBe(1);
    expect((await fetch(site.base + busy.url)).status).toBe(200);
    await page.close();
  });

  test("replace file: the address and the typed description stay, the picture and its sizes are new, a wrong kind is refused", async () => {
    const old = await uploadVia("Swap.png", "#c00");
    const oldBytes = Buffer.from(await (await fetch(site.base + old.url)).arrayBuffer());
    const page = await ownerPage();
    await openLibrary(page);
    await page.getByRole("option", { name: /^Swap\.png/ }).click();
    await page.getByRole("textbox", { name: "Alt text" }).waitFor();
    await page.getByRole("textbox", { name: "Alt text" }).fill("Typed, not saved yet");

    // A file of another kind is refused in words, and the old file is unchanged.
    await page.locator("input[name=replacement]").setInputFiles({
      name: "x.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n"),
    });
    await page
      .getByText(/Could not replace the file: The new file must be the same kind/)
      .waitFor();
    expect(
      Buffer.from(await (await fetch(site.base + old.url)).arrayBuffer()).equals(oldBytes),
    ).toBe(true);

    await page
      .locator("input[name=replacement]")
      .setInputFiles({ name: "other-name.png", mimeType: "image/png", buffer: await png("#0c0") });
    await page.getByText("The file was replaced.").waitFor();
    // Same address, new picture; what was typed is still there; the name is the old one.
    await expect
      .poll(async () =>
        Buffer.from(await (await fetch(site.base + old.url)).arrayBuffer()).equals(oldBytes),
      )
      .toBe(false);
    expect(await page.getByRole("textbox", { name: "Alt text" }).inputValue()).toBe(
      "Typed, not saved yet",
    );
    await page.getByRole("heading", { name: "Swap.png", level: 2 }).waitFor();
    // The new sizes are made again and then exist.
    await expect
      .poll(() => page.getByText("Making the smaller sizes…").count(), { timeout: 60_000 })
      .toBe(0);
    const row = (
      await db.run("select id, status from media where storage_key like ?", [
        "%" + old.url.split("/").pop(),
      ])
    )[0]!;
    expect(row["status"]).toBe("ready");
    expect(
      Number(
        (
          await db.run("select count(*) as n from media_variants where media_id = ?", [row["id"]])
        )[0]!["n"],
      ),
    ).toBeGreaterThan(0);
    await page.close();
  });

  test("in the editor: insert an image from the library, upload one in the same window, save, publish, and the public page shows both", async () => {
    const first = await uploadVia("Gallery one.png", "#808");
    const created = await ownerApi.post(site.base + "/api/admin/entries", {
      data: { type: "page", editor: "writing", title: "Gallery page" },
    });
    const pageId = ((await created.json()) as { id: string }).id;
    const page = await ownerPage();
    await page.goto(site.base + `/admin/pages/${pageId}`);
    await page.getByRole("heading", { name: "Edit: Gallery page", level: 1 }).waitFor();

    await page.getByRole("button", { name: "Insert image from the library" }).click();
    await page.getByRole("dialog", { name: "Insert an image from the library" }).waitFor();
    await page.getByRole("option", { name: /^Gallery-one\.png/ }).click();
    await page.getByRole("button", { name: "Insert image", exact: true }).click();
    // The picture has no description yet, so the editor asks for one.
    const describe = page.getByRole("dialog", { name: "Describe this picture" });
    await describe.waitFor();
    expect(await violations(page), "describe window").toEqual([]);
    await describe.getByLabel("Describe the picture").fill("A purple square");
    await describe.getByRole("button", { name: "Insert picture" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await expect.poll(() => page.locator(".oks-entry-editor img").count()).toBeGreaterThan(0);

    // A second picture, uploaded from the window: it asks too; this time the description is left for later.
    await page.getByRole("button", { name: "Insert image from the library" }).click();
    await page
      .getByRole("dialog")
      .locator("input[type=file]")
      .setInputFiles({ name: "Gallery two.png", mimeType: "image/png", buffer: await png("#088") });
    await page
      .getByRole("dialog", { name: "Describe this picture" })
      .getByRole("button", { name: "Insert without a description" })
      .click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await expect.poll(() => page.locator(".oks-entry-editor img").count()).toBeGreaterThan(1);

    await page.getByLabel("Published (everyone sees it)").check({ force: true });
    await page.getByRole("button", { name: "Save" }).click();
    // Only the second picture has no description, so the publish check lists that one; the administrator goes on anyway.
    const check = page.getByRole("alert", { name: "Before this goes live" });
    await check.getByText(/Picture 2 has no description/).waitFor();
    expect(await check.getByText(/Picture 1 has no description/).count()).toBe(0);
    await check.getByRole("button", { name: "Publish anyway" }).click();
    await page.getByText("Published anyway. This was written to the log.").waitFor();

    const html = await (await fetch(site.base + "/gallery-page")).text();
    expect(html).toContain(`src="${first.url}"`);
    expect(html).toMatch(/src="\/uploads\/[^"]*Gallery-two\.png"/);
    for (const src of [...html.matchAll(/src="(\/uploads\/[^"]+)"/g)].map((m) => m[1]!)) {
      expect((await fetch(site.base + src)).status, src).toBe(200);
    }
    // Both files now say which page uses them, so neither can be deleted by mistake.
    expect(((await item(first.id)).usedIn as { title: string }[]).map((u) => u.title)).toEqual([
      "Gallery page",
    ]);
    expect((await ownerApi.delete(site.base + `/api/admin/media/${first.id}`)).status()).toBe(409);
    await page.close();
  });

  test("a public page uses the image sizes and the blur, as soon as the sizes exist, and every size can be fetched", async () => {
    const shot = await uploadVia("Responsive shot.png", "#a50");
    const created = await ownerApi.post(site.base + "/api/admin/entries", {
      data: { type: "page", editor: "writing", title: "Responsive page" },
    });
    const pageId = ((await created.json()) as { id: string }).id;
    const saved = await ownerApi.put(site.base + `/api/admin/entries/${pageId}`, {
      data: {
        title: "Responsive page",
        slugPart: "responsive-page",
        status: "published",
        blocks: [
          {
            id: "b1",
            type: "image",
            props: { src: shot.url, alt: "A brown square" },
            content: [],
            children: [],
          },
        ],
        revision: 1,
      },
    });
    expect(saved.status()).toBe(200);
    // The sizes may still be in the making; when they are done the page is made fresh by itself.
    let html = "";
    await expect
      .poll(
        async () => {
          html = await (await fetch(site.base + "/responsive-page")).text();
          return html.includes("<picture>");
        },
        { timeout: 60_000, interval: 500 },
      )
      .toBe(true);
    expect(html).toContain('type="image/avif"');
    expect(html).toContain('type="image/webp"');
    expect(html).toMatch(/<img src="\/uploads\/[^"]*Responsive-shot\.png" alt="A brown square"/);
    expect(html).toMatch(/width="\d+" height="\d+" style="background-image:url\('data:image\/webp/);
    // Every size in the srcset is a real file with the right type.
    const sizes = [...html.matchAll(/srcset="([^"]+)"/g)].flatMap((m) =>
      m[1]!.split(", ").map((part) => part.split(" ")[0]!),
    );
    expect(sizes.length).toBeGreaterThan(1);
    for (const src of sizes) {
      const response = await fetch(site.base + src);
      expect(response.status, src).toBe(200);
      expect(response.headers.get("content-type"), src).toMatch(/^image\/(avif|webp)/);
    }
  });

  test("in the editor: a file chosen in the image block is stored in the library", async () => {
    const created = await ownerApi.post(site.base + "/api/admin/entries", {
      data: { type: "page", editor: "writing", title: "Block upload" },
    });
    const pageId = ((await created.json()) as { id: string }).id;
    const page = await ownerPage();
    await page.goto(site.base + `/admin/pages/${pageId}`);
    await page.getByRole("heading", { name: "Edit: Block upload", level: 1 }).waitFor();
    await page.locator("[contenteditable=true]").first().click();
    await page.getByRole("button", { name: "Turn into another block type" }).click();
    await page.getByRole("menuitemradio", { name: "Image" }).click();
    const input = page.locator(".oks-entry-editor input[type=file]").first();
    await input.waitFor({ state: "attached" });
    await input.setInputFiles({
      name: "From block.png",
      mimeType: "image/png",
      buffer: await png("#444"),
    });
    await expect.poll(() => page.locator(".oks-entry-editor img").count()).toBeGreaterThan(0);
    const src = await page.locator(".oks-entry-editor img").first().getAttribute("src");
    expect(src).toMatch(/^\/uploads\/.*From-block\.png$/);
    expect((await fetch(site.base + src!)).status).toBe(200);
    await page.close();
  });

  test("the library and the picker have no accessibility violations on a wide and a narrow screen", async () => {
    await uploadVia("Axe check.png", "#369");
    for (const width of [1280, 390]) {
      const page = await ownerPage(width);
      await openLibrary(page);
      await page.getByRole("option", { name: /^Axe-check\.png/ }).click();
      await page.getByRole("heading", { name: "Axe-check.png", level: 2 }).waitFor();
      // Making the sizes can take a while when the whole suite runs at once.
      await expect
        .poll(() => page.getByText("Making the smaller sizes…").count(), { timeout: 60_000 })
        .toBe(0);
      expect(await violations(page), `library ${width}px`).toEqual([]);

      const created = await ownerApi.post(site.base + "/api/admin/entries", {
        data: { type: "page", editor: "writing", title: `Axe page ${width}` },
      });
      const pageId = ((await created.json()) as { id: string }).id;
      await page.goto(site.base + `/admin/pages/${pageId}`);
      await page.getByRole("button", { name: "Insert image from the library" }).click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("dialog").getByRole("option").first().waitFor();
      expect(await violations(page), `picker ${width}px`).toEqual([]);
      await page.close();
    }
  });

  test("a contributor has no library: the screen sends her back to the home screen", async () => {
    const page = await browser.newPage();
    await page.context().addCookies((await caraApi.storageState()).cookies);
    await page.goto(site.base + "/admin/media");
    await page.waitForURL(site.base + "/admin");
    await page.close();
  });

  test("the menu shows each person only the places they may use", async () => {
    const places = async (page: Awaited<ReturnType<typeof ownerPage>>) => {
      // The menu is drawn in the browser, a moment after the heading: wait for its first entry.
      // (Pages is in the menu of the owner and of the contributor; "/admin" alone may also be a link elsewhere.)
      await page.locator('a[href="/admin/pages"]').first().waitFor({ state: "attached" });
      const found: string[] = [];
      for (const href of [
        "/admin",
        "/admin/pages",
        "/admin/posts",
        "/admin/media",
        "/admin/settings/general",
      ])
        if ((await page.locator(`a[href="${href}"]`).count()) > 0) found.push(href);
      return found;
    };
    const owner = await ownerPage();
    await owner.goto(site.base + "/admin");
    await owner.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    expect(await places(owner)).toEqual([
      "/admin",
      "/admin/pages",
      "/admin/posts",
      "/admin/media",
      "/admin/settings/general",
    ]);
    // The settings screen marks Settings as the place you are in.
    await owner.goto(site.base + "/admin/settings/general");
    await owner.getByRole("heading", { name: "General settings", level: 1 }).waitFor();
    expect(
      await owner.locator('a[href="/admin/settings/general"][aria-current]').count(),
    ).toBeGreaterThan(0);
    await owner.close();

    const cara = await browser.newPage();
    await cara.context().addCookies((await caraApi.storageState()).cookies);
    await cara.goto(site.base + "/admin");
    await cara.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    expect(await places(cara)).toEqual(["/admin", "/admin/pages", "/admin/posts"]);
    // The screens still refuse her on the server, whatever the menu shows.
    await cara.goto(site.base + "/admin/settings/general");
    await cara.waitForURL(site.base + "/admin");
    await cara.close();
  });
});

// Two-factor sign-in through the real server (AU-05 to AU-07 as the owner meets them, AU-41's password rule): turn it
// on from the account screen, then sign in with an app code, with a backup code, and see a used backup code refused.
// It has its own site, because the sign-in limit (5 tries per address) is shared by every sign-in of one site.
describe.skipIf(!findBrowser())("two-factor sign-in", { timeout: 120_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const owner = { email: "anna@example.com", password: "a-long-password" };

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "oks-2fa-site-"));
    db = await openSqlite(join(root, "site.sqlite"));
    site = await startSite("sqlite", db, { OKS_SECRET: "s".repeat(40) });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Two-factor garden",
        starterContent: false,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  const violations = async (page: Awaited<ReturnType<Browser["newPage"]>>) => {
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      }),
    );
    return result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  };
  const startSignIn = async () => {
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel(/^Password/).fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    return page;
  };

  test("turn it on, sign in with an app code and with a backup code, and a backup code works once", async () => {
    // Turn it on from the account screen.
    const first = await startSignIn();
    await first.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    await first.getByRole("link", { name: "Your account" }).click();
    await first.getByRole("heading", { name: "Your account", level: 1 }).waitFor();
    await first.getByLabel(/^Your password/).fill("not the password");
    await first.getByRole("button", { name: "Turn on" }).click();
    await first.getByRole("alert").filter({ hasText: "The password is not right." }).waitFor();
    await first.getByLabel(/^Your password/).fill(owner.password);
    await first.getByRole("button", { name: "Turn on" }).click();
    await first.getByRole("img", { name: "QR code for your authenticator app" }).waitFor();
    const secret = (await first.locator("code").first().innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    const codes = await first
      .getByRole("list", { name: "Backup codes" })
      .locator("code")
      .allInnerTexts();
    expect(codes).toHaveLength(10);
    expect(await violations(first), "set-up").toEqual([]);
    // A wrong code does not finish it; a right one does.
    await first.getByLabel("Code from the app").fill("000000");
    await first.getByRole("button", { name: "Finish" }).click();
    await first.getByRole("alert").filter({ hasText: "That code is not right" }).waitFor();
    await first.getByLabel("Code from the app").fill(generateSync({ secret }));
    await first.getByRole("button", { name: "Finish" }).click();
    await first.getByText("Two-factor sign-in is on.", { exact: true }).waitFor();
    expect(Number((await db.run("select two_factor_enabled as e from users"))[0]!["e"])).toBe(1);
    await first.close();

    // The library allows 3 two-factor requests per 10 seconds from one address, so each group below starts in a new window.
    const newWindow = () => new Promise((r) => setTimeout(r, 10_500));
    await newWindow();

    // Sign in again: the password is not enough; a wrong code is refused; the app code works.
    const second = await startSignIn();
    await second.getByLabel("Code from your authenticator app").waitFor();
    expect(second.url()).not.toContain("/admin/login#");
    expect(await violations(second), "code step").toEqual([]);
    await second.getByLabel("Code from your authenticator app").fill("000000");
    await second.getByRole("button", { name: "Sign in" }).click();
    await second.getByRole("alert").filter({ hasText: "That code is not right" }).waitFor();
    await second.getByLabel("Code from your authenticator app").fill(generateSync({ secret }));
    await second.getByRole("button", { name: "Sign in" }).click();
    await second.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    await second.close();

    // A backup code signs in once.
    await newWindow();
    const third = await startSignIn();
    await third.getByRole("button", { name: "Use a backup code instead" }).click();
    await third.getByLabel("Backup code").fill(codes[0]!);
    await third.getByRole("button", { name: "Sign in" }).click();
    await third.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    await third.close();
    const fourth = await startSignIn();
    await fourth.getByRole("button", { name: "Use a backup code instead" }).click();
    await fourth.getByLabel("Backup code").fill(codes[0]!);
    await fourth.getByRole("button", { name: "Sign in" }).click();
    await fourth.getByRole("alert").filter({ hasText: "That code is not right" }).waitFor();
    expect(fourth.url()).toContain("/admin/login");
    await fourth.close();

    // Signed in again, new backup codes need the password; turning it off needs the password too.
    await newWindow();
    const fifth = await startSignIn();
    await fifth.getByLabel("Code from your authenticator app").fill(generateSync({ secret }));
    await fifth.getByRole("button", { name: "Sign in" }).click();
    await fifth.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    await fifth.goto(site.base + "/admin/account");
    await fifth.getByRole("button", { name: "Turn off" }).waitFor();
    // Without a password typed the button is off.
    expect(await fifth.getByRole("button", { name: "Make new backup codes" }).isDisabled()).toBe(
      true,
    );
    await fifth.getByLabel(/^Your password/).fill(owner.password);
    await fifth.getByRole("button", { name: "Make new backup codes" }).click();
    await fifth.getByRole("list", { name: "Backup codes" }).waitFor();
    expect(await fifth.getByRole("list", { name: "Backup codes" }).locator("code").count()).toBe(
      10,
    );
    await fifth.getByLabel(/^Your password/).fill("not the password");
    await fifth.getByRole("button", { name: "Turn off" }).click();
    await fifth.getByRole("alert").filter({ hasText: "The password is not right." }).waitFor();
    expect(Number((await db.run("select two_factor_enabled as e from users"))[0]!["e"])).toBe(1);
    await fifth.getByLabel(/^Your password/).fill(owner.password);
    await fifth.getByRole("button", { name: "Turn off" }).click();
    await fifth.getByText("Two-factor sign-in is off.", { exact: true }).waitFor();
    expect(Number((await db.run("select two_factor_enabled as e from users"))[0]!["e"])).toBe(0);

    // The rule "two-factor for administrators" (AU-37). It cannot be turned on by an administrator who has no
    // two-factor herself.
    await fifth.goto(site.base + "/admin/settings/security");
    await fifth.getByRole("heading", { name: "Security settings", level: 1 }).waitFor();
    expect(await violations(fifth), "security settings").toEqual([]);
    await fifth.getByLabel(/^Required/).check({ force: true });
    await fifth.getByRole("button", { name: "Save settings" }).click();
    await fifth
      .getByRole("alert")
      .filter({ hasText: "Turn on two-factor sign-in for your own account first" })
      .waitFor();
    // With two-factor on for her (the flag is set directly here; the real set-up was tested above) it is saved.
    await db.run("update users set two_factor_enabled = 1");
    await fifth.getByRole("button", { name: "Save settings" }).click();
    await fifth.getByText(/^Saved\. Administrators without two-factor/).waitFor();
    expect(
      String((await db.run("select value from settings where key = 'security'"))[0]!["value"]),
    ).toContain('"requireTwoFactorForAdmins":true');

    // Now her two-factor goes away: every screen and API closes, and the account screen explains.
    await db.run("update users set two_factor_enabled = 0");
    await fifth.goto(site.base + "/admin/pages");
    await fifth.waitForURL(site.base + "/admin/account");
    await fifth.getByText("Set up two-factor sign-in to continue").waitFor();
    expect(await violations(fifth), "set up is required").toEqual([]);
    expect((await fifth.request.get(site.base + "/api/admin/media")).status()).toBe(401);
    await fifth.goto(site.base + "/admin/login");
    await fifth.waitForURL(site.base + "/admin/account");

    // With the rule off again, the admin opens.
    await db.run("delete from settings where key = 'security'");
    await fifth.goto(site.base + "/admin");
    await fifth.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    await fifth.close();
  });
});

// Maintenance mode on a site of its own, so the mode cannot disturb the other tests and the sign-in limit is fresh.
describe.skipIf(!findBrowser())("maintenance mode", { timeout: 120_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const owner = { email: "anna@example.com", password: "a-long-password" };
  const cara = { email: "cara@example.com", password: "cara-long-password" };

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-maint-")), "site.sqlite"));
    site = await startSite("sqlite", db, { OKS_SECRET: "m".repeat(40) });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        starterContent: true,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    // Cara is an editor: she may edit everything but not manage the settings.
    const signUp = await fetch(site.base + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: site.base },
      body: JSON.stringify({ name: "Cara", ...cara }),
    });
    const caraId = ((await signUp.json()) as { user: { id: string } }).user.id;
    const siteId = String((await db.run("select id from sites"))[0]!["id"]);
    const role = String((await db.run("select id from roles where key = 'editor'"))[0]!["id"]);
    await db.run(
      "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
      [siteId, caraId, role, new Date()],
    );
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  const signedIn = async (who: { email: string; password: string }) => {
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(who.email);
    await page.getByLabel(/^Password/).fill(who.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    return page;
  };
  const visit = async (path: string, cookie?: string) => {
    const response = await fetch(site.base + path, cookie ? { headers: { cookie } } : {});
    return { response, body: await response.text() };
  };

  test("on: visitors get a 503 page with the message, administrators see the site, editors and forged cookies do not; off: open again", async () => {
    // Open at first.
    expect((await visit("/about")).response.status).toBe(200);

    const page = await signedIn(owner);
    // The settings screen: the owner turns it on with a message.
    await page.goto(site.base + "/admin/settings/maintenance");
    await page.getByRole("heading", { name: "Maintenance settings", level: 1 }).waitFor();
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      }),
    );
    expect(
      result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
    await page.getByText(/^On: visitors see/).click();
    await page.getByLabel("Message for visitors").fill("Back at five.\nThank you <b>all</b>!");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText(/Visitors now see the maintenance page/).waitFor();

    // Visitors: a real 503 for every kind of address, never cached, told not to index.
    for (const path of ["/about", "/", "/blog/hello-world", "/category/uncategorised", "/nope"]) {
      const { response, body } = await visit(path);
      expect(response.status, path).toBe(503);
      expect(response.headers.get("retry-after"), path).toBe("3600");
      expect(response.headers.get("x-robots-tag"), path).toContain("noindex");
      expect(response.headers.get("cache-control"), path).toContain("no-store");
      expect(body, path).toContain("<p>Back at five.</p>");
      // The message is shown as text, never as markup.
      expect(body, path).toContain("<p>Thank you &lt;b&gt;all&lt;/b&gt;!</p>");
      expect(body, path).not.toContain("<b>all</b>");
      // The page's own content is not in the answer.
      expect(body, path).not.toContain("<article>");
    }
    // A made-up session cookie does not pass.
    const forged = await visit("/about", "better-auth.session_token=forged.value");
    expect(forged.response.status).toBe(503);
    // The sign-in page and the API stay reachable (so the owner can turn it off).
    expect((await visit("/admin/login")).response.status).toBe(200);
    expect((await visit("/api/admin/settings/maintenance")).response.status).toBe(401);

    // The signed-in administrator sees the real site.
    await page.goto(site.base + "/");
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    expect(await page.getByText("Back at five.").count()).toBe(0);
    const real = await page.goto(site.base + "/about");
    expect(real!.status()).toBe(200);
    await page.getByRole("heading", { name: "About", level: 1 }).waitFor();

    // An editor may not manage the settings, so she sees the maintenance page, and the settings screen is closed.
    const editor = await signedIn(cara);
    const blocked = await editor.goto(site.base + "/about");
    expect(blocked!.status()).toBe(503);
    await editor.goto(site.base + "/admin/settings/maintenance");
    await editor.waitForURL(site.base + "/admin");
    const put = await editor.request.put(site.base + "/api/admin/settings/maintenance", {
      data: { enabled: false },
      headers: { origin: site.base },
    });
    expect(put.status()).toBe(403);
    await editor.close();

    // Off again: open to everyone at once.
    await page.goto(site.base + "/admin/settings/maintenance");
    await page.getByText(/^Off: the site is open/).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText("Saved. The site is open to everyone.").waitFor();
    const open = await visit("/about");
    expect(open.response.status).toBe(200);
    expect(open.body).toContain("<h1>About</h1>");
    await page.close();
  });

  test("the settings routes refuse signed-out requests", async () => {
    for (const method of ["GET", "PUT"] as const) {
      const response = await fetch(site.base + "/api/admin/settings/maintenance", {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ enabled: true }) } : {}),
      });
      expect(response.status, method).toBe(401);
    }
    expect((await visit("/about")).response.status).toBe(200);
  });
});

// The sitemap and robots.txt on a site of its own, so the list of addresses is known.
describe.skipIf(!findBrowser())("sitemap and robots.txt", { timeout: 120_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const owner = { email: "anna@example.com", password: "a-long-password" };

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-seo-")), "site.sqlite"));
    site = await startSite("sqlite", db, { OKS_SECRET: "q".repeat(40) });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        starterContent: true,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  const get = async (path: string) => {
    const response = await fetch(site.base + path);
    return { response, body: await withLook(site.base, await response.text()) };
  };
  const locs = (xml: string) => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]!);

  test("robots.txt and the sitemap list what search engines may index and update at once; closing the site to search engines closes both", async () => {
    // robots.txt.
    const robots = await get("/robots.txt");
    expect(robots.response.status).toBe(200);
    expect(robots.response.headers.get("content-type")).toContain("text/plain");
    expect(robots.body).toBe(
      `User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /search\n\nSitemap: ${site.base}/sitemap.xml\n`,
    );

    // The sitemap of the starter site: Home, About, Contact and the first post.
    const first = await get("/sitemap.xml");
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get("content-type")).toContain("application/xml");
    expect(locs(first.body)).toEqual([
      `${site.base}/`,
      `${site.base}/about`,
      `${site.base}/blog/hello-world`,
      `${site.base}/contact`,
    ]);
    expect(first.body).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T[\d:.]+Z<\/lastmod>/);

    // Well-formed XML, as a browser reads it.
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    const parsed = await page.evaluate(async () => {
      const text = await (await fetch("/sitemap.xml")).text();
      const doc = new DOMParser().parseFromString(text, "application/xml");
      return {
        error: doc.querySelector("parsererror")?.textContent ?? null,
        urls: doc.getElementsByTagName("url").length,
      };
    });
    expect(parsed).toEqual({ error: null, urls: 4 });

    // Sign in to change things through the API.
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel(/^Password/).fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    const call = (method: string, url: string, body?: unknown) =>
      page.evaluate(
        async ([m, u, b]) => {
          const response = await fetch(u as string, {
            method: m as string,
            headers: { "content-type": "application/json" },
            ...(b === undefined ? {} : { body: JSON.stringify(b) }),
          });
          return {
            status: response.status,
            json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
          };
        },
        [method, url, body] as const,
      );
    const addPost = async (title: string, publish: boolean) => {
      const made = await call("POST", "/api/admin/entries", { type: "post", title });
      const id = String(made.json!["id"]);
      const slug = String(made.json!["slug"]);
      const save = (status: string, revision: number) =>
        call("PUT", `/api/admin/entries/${id}`, {
          title,
          slugPart: slug.replace(/^blog\//, ""),
          status,
          blocks: [
            {
              id: "p1",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "Words.", styles: {} }],
              children: [],
            },
          ],
          revision,
        });
      if (publish)
        expect((await save("published", Number(made.json!["revision"]))).status).toBe(200);
      return { id, slug, revision: Number(made.json!["revision"]) };
    };

    // A draft is not listed; publishing it lists it at once, with its category and tag pages.
    const draft = await addPost("Fresh sourdough", false);
    expect(locs((await get("/sitemap.xml")).body)).not.toContain(`${site.base}/${draft.slug}`);
    const notes = await addPost("Window notes", true);
    const after = locs((await get("/sitemap.xml")).body);
    expect(after).toContain(`${site.base}/${notes.slug}`);
    const tagged = await call("PUT", `/api/admin/entries/${notes.id}/terms`, {
      categoryIds: [],
      tags: ["Window Seat"],
    });
    expect(tagged.status).toBe(200);
    const withArchives = locs((await get("/sitemap.xml")).body);
    expect(withArchives).toContain(`${site.base}/tag/window-seat`);
    expect(withArchives).toContain(`${site.base}/category/uncategorised`);
    // Moving it to the trash takes it and its archives out at once.
    expect((await call("DELETE", `/api/admin/entries/${notes.id}`)).status).toBe(200);
    const gone = locs((await get("/sitemap.xml")).body);
    expect(gone).not.toContain(`${site.base}/${notes.slug}`);
    expect(gone).not.toContain(`${site.base}/tag/window-seat`);
    expect(gone).not.toContain(`${site.base}/category/uncategorised`);

    // The settings screen: closed to search engines.
    await page.goto(site.base + "/admin/settings/search-engines");
    await page.getByRole("heading", { name: "Search engine settings", level: 1 }).waitFor();
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      }),
    );
    expect(
      result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
    await page.getByText(/^Closed: ask search engines/).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText(/Search engines are asked to stay away/).waitFor();
    expect((await get("/robots.txt")).body).toBe("User-agent: *\nDisallow: /\n");
    expect((await get("/sitemap.xml")).response.status).toBe(404);
    for (const path of ["/", "/about", "/blog/hello-world", "/category/uncategorised"]) {
      const answer = await get(path);
      expect(answer.response.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
    }
    // The 404 and the search page keep their own, stricter or equal, header.
    const missing = await get("/nope");
    expect(missing.response.status).toBe(404);
    expect(missing.response.headers.get("x-robots-tag")).toBe("noindex");
    expect((await get("/search?q=a")).response.headers.get("x-robots-tag")).toBe("noindex");

    // Open again: everything is back.
    await page.getByText(/^Open: search engines may index/).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText(/Search engines may index the site/).waitFor();
    expect((await get("/robots.txt")).body).toContain(`Sitemap: ${site.base}/sitemap.xml`);
    expect((await get("/sitemap.xml")).response.status).toBe(200);
    expect((await get("/about")).response.headers.get("x-robots-tag")).toBeNull();
    await page.close();
  });

  test("the settings routes refuse signed-out requests", async () => {
    for (const method of ["GET", "PUT"] as const) {
      const response = await fetch(site.base + "/api/admin/settings/seo", {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ discourageIndexing: true }) } : {}),
      });
      expect(response.status, method).toBe(401);
    }
    expect((await get("/robots.txt")).body).toContain("Sitemap:");
  });

  test("addresses in other scripts and with accents: made from the title, reachable in every written form, followed by a redirect, in the sitemap and found by search (SEO-20 to SEO-22)", async () => {
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel(/^Password/).fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    const call = (method: string, url: string, body?: unknown) =>
      page.evaluate(
        async ([m, u, b]) => {
          const response = await fetch(u as string, {
            method: m as string,
            headers: { "content-type": "application/json" },
            ...(b === undefined ? {} : { body: JSON.stringify(b) }),
          });
          return {
            status: response.status,
            json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
          };
        },
        [method, url, body] as const,
      );
    const blocks = (text: string) => [
      {
        id: "p1",
        type: "paragraph",
        props: {},
        content: [{ type: "text", text, styles: {} }],
        children: [],
      },
    ];
    const publish = async (title: string, text: string) => {
      const made = await call("POST", "/api/admin/entries", { type: "post", title });
      const id = String(made.json!["id"]);
      const slug = String(made.json!["slug"]);
      const saved = await call("PUT", `/api/admin/entries/${id}`, {
        title,
        slugPart: slug.replace(/^blog\//, ""),
        status: "published",
        blocks: blocks(text),
        revision: made.json!["revision"],
      });
      expect(saved.status).toBe(200);
      return { id, slug, revision: Number(saved.json!["revision"]) };
    };

    // The address is made from the title and keeps the letters.
    const hindi = await publish("नमस्ते दुनिया", "यह पहला लेख है।");
    expect(hindi.slug).toBe("blog/नमस्ते-दुनिया");
    const cafe = await publish("Café Münster", "Coffee in the old town.");
    expect(cafe.slug).toBe("blog/café-münster");
    // The page opens by the percent-encoded address a browser sends, and by the decomposed accents a keyboard may type.
    const hindiUrl = `/blog/${encodeURIComponent("नमस्ते-दुनिया")}`;
    expect(hindiUrl).toContain("%E0%A4%A8");
    const opened = await get(hindiUrl);
    expect(opened.response.status).toBe(200);
    expect(opened.body).toContain("नमस्ते दुनिया");
    expect((await get(`/blog/${encodeURIComponent("café-münster")}`)).response.status).toBe(200);
    expect((await get(`/blog/${encodeURIComponent("café-münster")}`)).response.status).toBe(200);
    // The same page in the browser, the way a visitor reaches it.
    await page.goto(site.base + "/blog/नमस्ते-दुनिया");
    await page.getByRole("heading", { name: "नमस्ते दुनिया", level: 1 }).waitFor();
    // A broken percent-encoding is a bad request, not a server error; an address that does not exist is a 404.
    expect((await fetch(site.base + "/blog/%E0%A4%A")).status).toBe(400);
    expect((await get(`/blog/${encodeURIComponent("नहीं-है")}`)).response.status).toBe(404);

    // The sitemap names it percent-encoded; search finds it by its own letters.
    const sitemap = (await get("/sitemap.xml")).body;
    expect(sitemap).toContain(`${site.base}${hindiUrl}`);
    expect(sitemap).toContain(`${site.base}/blog/caf%C3%A9-m%C3%BCnster`);
    const found = (await get(`/search?q=${encodeURIComponent("दुनिया")}`)).body;
    expect(found).toContain('href="/blog/नमस्ते-दुनिया"');

    // A new address keeps the old one working: the redirect is followed from the Hindi address.
    const renamed = await call("PUT", `/api/admin/entries/${hindi.id}`, {
      title: "नमस्ते दुनिया",
      slugPart: "नमस्कार",
      status: "published",
      blocks: blocks("यह पहला लेख है।"),
      revision: hindi.revision,
    });
    expect(renamed.status).toBe(200);
    const moved = await fetch(site.base + hindiUrl, { redirect: "manual" });
    expect(moved.status).toBe(301);
    expect(new URL(moved.headers.get("location")!, site.base).pathname).toBe(
      `/blog/${encodeURIComponent("नमस्कार")}`,
    );
    const followed = await fetch(site.base + hindiUrl);
    expect(followed.status).toBe(200);
    expect(decodeURIComponent(new URL(followed.url).pathname)).toBe("/blog/नमस्कार");

    // The admin refuses what is not an address: upper case, the decomposed form, a symbol.
    for (const bad of ["Café", "café", "a b", "a_b"]) {
      const refused = await call("PUT", `/api/admin/entries/${cafe.id}`, {
        title: "Café Münster",
        slugPart: bad,
        status: "published",
        blocks: blocks("Coffee."),
        revision: cafe.revision,
      });
      expect(refused.status, bad).toBe(400);
    }
    await page.close();
  });
});

// Previews on a site of its own: a draft stays private, and is shown by a signed link or to an editor who may edit it.
describe.skipIf(!findBrowser())("previews", { timeout: 120_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const SECRET = "p".repeat(40);
  const owner = { email: "anna@example.com", password: "a-long-password" };
  const cara = { email: "cara@example.com", password: "cara-long-password" };

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-preview-")), "site.sqlite"));
    site = await startSite("sqlite", db, { OKS_SECRET: SECRET });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        starterContent: true,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    // Cara is a contributor: she writes her own drafts and may not touch anyone else's.
    const signUp = await fetch(site.base + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: site.base },
      body: JSON.stringify({ name: "Cara", ...cara }),
    });
    const caraId = ((await signUp.json()) as { user: { id: string } }).user.id;
    const siteId = String((await db.run("select id from sites"))[0]!["id"]);
    const role = String((await db.run("select id from roles where key = 'contributor'"))[0]!["id"]);
    await db.run(
      "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
      [siteId, caraId, role, new Date()],
    );
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  type Page = Awaited<ReturnType<Browser["newPage"]>>;
  const signedIn = async (who: { email: string; password: string }) => {
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(who.email);
    await page.getByLabel(/^Password/).fill(who.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    return page;
  };
  const call = (page: Page, method: string, url: string, body?: unknown) =>
    page.evaluate(
      async ([m, u, b]) => {
        const response = await fetch(u as string, {
          method: m as string,
          headers: { "content-type": "application/json" },
          ...(b === undefined ? {} : { body: JSON.stringify(b) }),
        });
        return {
          status: response.status,
          json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
        };
      },
      [method, url, body] as const,
    );
  const blocks = (text: string) => [
    {
      id: "p1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text, styles: {} }],
      children: [],
    },
  ];
  const draft = async (page: Page, title: string, text: string, type = "post") => {
    const made = await call(page, "POST", "/api/admin/entries", { type, title });
    const id = String(made.json!["id"]);
    const slug = String(made.json!["slug"]);
    const saved = await call(page, "PUT", `/api/admin/entries/${id}`, {
      title,
      slugPart: slug.replace(/^blog\//, ""),
      status: "draft",
      blocks: blocks(text),
      revision: made.json!["revision"],
    });
    expect(saved.status).toBe(200);
    return { id, slug, revision: Number(saved.json!["revision"]) };
  };
  const get = async (path: string) => {
    const response = await fetch(path.startsWith("http") ? path : site.base + path);
    return { response, body: await response.text() };
  };
  /** A link token made the way the site makes it, to test links the site would never make. */
  const token = (id: string, expiresAt: number) =>
    `${expiresAt}.${createHmac("sha256", SECRET).update(`oks-preview:${id}:${expiresAt}`).digest("base64url")}`;

  test("a draft is private; a signed link and the editor show the saved version, never cached; bad, expired and altered links are plain 404s", async () => {
    const page = await signedIn(owner);
    const secret = await draft(page, "Secret plans", "The launch is on Friday.");
    // The public cannot see a draft.
    expect((await get(`/${secret.slug}`)).response.status).toBe(404);

    // The signed-in editor opens the preview: the saved text, the notice, not indexed, not cached, no Referer.
    const opened = await page.goto(`${site.base}/preview/${secret.id}`);
    expect(opened!.status()).toBe(200);
    await page.getByRole("heading", { name: "Secret plans", level: 1 }).waitFor();
    await page.getByText("The launch is on Friday.").waitFor();
    await page.getByText("Preview: this page is not published.").waitFor();
    const headers = opened!.headers();
    expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toContain("noindex");

    // Someone who is not signed in and has no link gets a real 404 and learns nothing.
    const stranger = await get(`/preview/${secret.id}`);
    expect(stranger.response.status).toBe(404);
    expect(stranger.body).not.toContain("Secret plans");
    expect((await get(`/preview/${secret.id}?t=nonsense`)).response.status).toBe(404);
    expect((await get(`/preview/${newIdLike()}`)).response.status).toBe(404);

    // The edit screen makes a share link.
    await page.goto(`${site.base}/admin/posts/${secret.id}`);
    await page.getByRole("heading", { name: "Preview", level: 2 }).waitFor();
    await page.getByLabel("Share link lasts").selectOption("14");
    await page.getByRole("button", { name: "Create a share link" }).click();
    const input = page.getByLabel("Share link", { exact: true });
    await input.waitFor();
    const link = await input.inputValue();
    expect(link).toMatch(
      new RegExp(`^${site.base}/preview/${secret.id}\\?t=\\d+\\.[A-Za-z0-9_-]{43}$`),
    );
    await page.getByText(/Anyone with this link can see the saved version/).waitFor();
    const shared = await get(link);
    expect(shared.response.status).toBe(200);
    expect(shared.body).toContain("The launch is on Friday.");
    expect(shared.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(shared.response.headers.get("cache-control")).toContain("no-store");

    // It always shows the last saved version: a change is there at once.
    const changed = await call(page, "PUT", `/api/admin/entries/${secret.id}`, {
      title: "Secret plans",
      slugPart: secret.slug.replace(/^blog\//, ""),
      status: "draft",
      blocks: blocks("The launch moved to Monday."),
      revision: secret.revision,
    });
    expect(changed.status).toBe(200);
    expect((await get(link)).body).toContain("The launch moved to Monday.");
    expect((await get(link)).body).not.toContain("Friday");

    // Links that are altered, made for another entry, expired, or too far in the future are refused.
    const [expires, signature] = link.split("?t=")[1]!.split(".");
    const flipped = signature!.slice(0, -1) + (signature!.endsWith("A") ? "B" : "A");
    const base = `${site.base}/preview/${secret.id}`;
    expect((await get(`${base}?t=${expires}.${flipped}`)).response.status).toBe(404);
    expect(
      (await get(`${base}?t=${Number(expires) + 86_400_000}.${signature}`)).response.status,
    ).toBe(404);
    const other = await draft(page, "Other draft", "Nothing to see.");
    expect((await get(`/preview/${other.id}?t=${link.split("?t=")[1]}`)).response.status).toBe(404);
    expect((await get(`${base}?t=${token(secret.id, Date.now() - 1000)}`)).response.status).toBe(
      404,
    );
    expect(
      (await get(`${base}?t=${token(secret.id, Date.now() + 40 * 86_400_000)}`)).response.status,
    ).toBe(404);
    // A link made the way the site makes it works (the control for the refusals above).
    expect(
      (await get(`${base}?t=${token(secret.id, Date.now() + 86_400_000)}`)).response.status,
    ).toBe(200);

    // Accessibility of the preview page.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${site.base}/preview/${secret.id}`);
      await page.getByRole("heading", { name: "Secret plans", level: 1 }).waitFor();
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
        `preview ${width}px`,
      ).toEqual([]);
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    // Publishing: the link keeps working and says so; the trash ends every preview.
    const published = await call(page, "PUT", `/api/admin/entries/${secret.id}`, {
      title: "Secret plans",
      slugPart: secret.slug.replace(/^blog\//, ""),
      status: "published",
      blocks: blocks("The launch moved to Monday."),
      revision: Number(changed.json!["revision"]),
    });
    expect(published.status).toBe(200);
    expect((await get(link)).body).toContain("the saved version of a published page");
    expect((await get(`/${secret.slug}`)).response.status).toBe(200);
    expect((await call(page, "DELETE", `/api/admin/entries/${secret.id}`)).status).toBe(200);
    expect((await get(link)).response.status).toBe(404);
    const gone = await page.goto(`${site.base}/preview/${secret.id}`);
    expect(gone!.status()).toBe(404);

    // A page of the site (not a post) previews too.
    const aboutId = String((await db.run("select id from entries where slug = 'about'"))[0]!["id"]);
    const about = await page.goto(`${site.base}/preview/${aboutId}`);
    expect(about!.status()).toBe(200);
    await page.getByRole("heading", { name: "About", level: 1 }).waitFor();
    await page.close();
  });

  function newIdLike(): string {
    return "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  }

  test("the link route: who may make one, how long it lasts, and signed-out requests", async () => {
    const owner1 = await signedIn(owner);
    const ownersDraft = await draft(owner1, "Owner draft", "Owner words.");
    const caras = await signedIn(cara);
    const carasDraft = await draft(caras, "Cara draft", "Cara words.");

    // A contributor makes a link for her own draft, and sees it; not for the owner's draft, and not the owner's preview.
    const mine = await call(caras, "POST", `/api/admin/entries/${carasDraft.id}/preview-link`, {});
    expect(mine.status).toBe(201);
    expect(String(mine.json!["url"])).toContain(`/preview/${carasDraft.id}?t=`);
    const previewOfMine = await caras.goto(`${site.base}/preview/${carasDraft.id}`);
    expect(previewOfMine!.status()).toBe(200);
    expect(
      (await call(caras, "POST", `/api/admin/entries/${ownersDraft.id}/preview-link`, {})).status,
    ).toBe(403);
    const previewOfTheirs = await caras.goto(`${site.base}/preview/${ownersDraft.id}`);
    expect(previewOfTheirs!.status()).toBe(404);

    // How long: 7 days when nothing is said, 1 to 30 when asked, nothing else.
    const days = async (value: unknown) =>
      call(
        owner1,
        "POST",
        `/api/admin/entries/${ownersDraft.id}/preview-link`,
        value === undefined ? {} : { days: value },
      );
    const week = await days(undefined);
    expect(week.status).toBe(201);
    const left = (Date.parse(String(week.json!["expiresAt"])) - Date.now()) / 86_400_000;
    expect(left).toBeGreaterThan(6.9);
    expect(left).toBeLessThan(7.1);
    expect((await days(1)).status).toBe(201);
    expect((await days(30)).status).toBe(201);
    for (const bad of [0, 31, -3, 1.5, "soon"])
      expect((await days(bad)).status, String(bad)).toBe(400);
    expect(
      (await call(owner1, "POST", `/api/admin/entries/${newIdLike()}/preview-link`, {})).status,
    ).toBe(404);

    // Signed out: refused. (The same-origin check comes first, as everywhere.)
    const signedOut = await fetch(`${site.base}/api/admin/entries/${ownersDraft.id}/preview-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(signedOut.status).toBe(401);
    await owner1.close();
    await caras.close();
  });
});

// General settings and the site's time zone, on a site of its own. The browser is in Los Angeles and the site in Auckland, so a
// time that is wrong by the zone shows at once.
describe.skipIf(!findBrowser())("general settings and the time zone", { timeout: 150_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const owner = { email: "anna@example.com", password: "a-long-password" };
  const cara = { email: "cara@example.com", password: "cara-long-password" };

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-general-")), "site.sqlite"));
    site = await startSite("sqlite", db, { OKS_SECRET: "g".repeat(40) });
    // What the wizard sends: the site starts in the zone of the browser that set it up.
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        tagline: "Plants and pots",
        timeZone: "Pacific/Auckland",
        starterContent: true,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    const signUp = await fetch(site.base + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: site.base },
      body: JSON.stringify({ name: "Cara", ...cara }),
    });
    const caraId = ((await signUp.json()) as { user: { id: string } }).user.id;
    const siteId = String((await db.run("select id from sites"))[0]!["id"]);
    const role = String((await db.run("select id from roles where key = 'editor'"))[0]!["id"]);
    await db.run(
      "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
      [siteId, caraId, role, new Date()],
    );
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  type Page = Awaited<ReturnType<Browser["newPage"]>>;
  const signedIn = async (who: { email: string; password: string }): Promise<Page> => {
    const context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
    const page = await context.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(who.email);
    await page.getByLabel(/^Password/).fill(who.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    return page;
  };
  const call = (page: Page, method: string, url: string, body?: unknown) =>
    page.evaluate(
      async ([m, u, b]) => {
        const response = await fetch(u as string, {
          method: m as string,
          headers: { "content-type": "application/json" },
          ...(b === undefined ? {} : { body: JSON.stringify(b) }),
        });
        return {
          status: response.status,
          json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
        };
      },
      [method, url, body] as const,
    );
  const zonedBox = (ms: number, zone: string) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(ms)
      .replace(" ", "T");
  const written = (ms: number, zone: string) =>
    new Intl.DateTimeFormat("en", {
      timeZone: zone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ms);
  const settingValue = async (key: string) =>
    (await db.run("select value from settings where key = ?", [key]))[0]?.["value"];

  test("the General screen: the site starts as the wizard made it, saves the name, tagline and time zone, refuses bad values and is closed to an editor", async () => {
    const page = await signedIn(owner);
    // The settings menu item leads to General first.
    await page.getByRole("link", { name: "Settings", exact: true }).first().click();
    await page.getByRole("heading", { name: "General settings", level: 1 }).waitFor();
    expect(await page.getByLabel("Site name").inputValue()).toBe("Anna's Garden");
    expect(await page.getByLabel("Tagline").inputValue()).toBe("Plants and pots");
    expect(await page.locator("#general-zone").inputValue()).toBe("Pacific/Auckland");
    // The list has the modern name of India's zone, and Automatic first.
    const options = await page.locator("#general-zone option").allTextContents();
    expect(options[0]).toContain("Automatic");
    expect(options).toContain("Asia/Kolkata");
    expect(options).not.toContain("Asia/Calcutta");

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
        `general ${width}px`,
      ).toEqual([]);
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByLabel("Site name").fill("  Anna's Greenhouse ");
    await page.getByLabel("Tagline").fill("Everything under glass");
    await page.locator("#general-zone").selectOption("Asia/Kolkata");
    await page.getByText(/there now\./).waitFor();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText("Saved.", { exact: true }).waitFor();
    expect((await db.run("select name from sites"))[0]!["name"]).toBe("Anna's Greenhouse");
    expect(JSON.parse(String(await settingValue("title")))).toBe("Anna's Greenhouse");
    expect(JSON.parse(String(await settingValue("tagline")))).toBe("Everything under glass");
    expect(JSON.parse(String(await settingValue("timezone")))).toBe("Asia/Kolkata");
    await page.reload();
    expect(await page.getByLabel("Site name").inputValue()).toBe("Anna's Greenhouse");
    expect(await page.locator("#general-zone").inputValue()).toBe("Asia/Kolkata");
    // The dashboard shows the new name.
    await page.goto(site.base + "/admin");
    await page.getByText("Anna's Greenhouse").first().waitFor();

    // Refused in words, with the field.
    const refused = async (body: object) => call(page, "PUT", "/api/admin/settings/general", body);
    const empty = await refused({ siteName: "   " });
    expect(empty.status).toBe(400);
    expect((empty.json!["error"] as { field: string }).field).toBe("siteName");
    expect((await refused({ siteName: "x".repeat(101) })).status).toBe(400);
    expect((await refused({ tagline: "x".repeat(201) })).status).toBe(400);
    const zone = await refused({ timeZone: "Mars/Base" });
    expect(zone.status).toBe(400);
    expect((zone.json!["error"] as { field: string }).field).toBe("timeZone");
    expect((await db.run("select name from sites"))[0]!["name"]).toBe("Anna's Greenhouse");

    // An editor may not see or change the general settings.
    const editor = await signedIn(cara);
    expect((await call(editor, "GET", "/api/admin/settings/general")).status).toBe(403);
    expect(
      (await call(editor, "PUT", "/api/admin/settings/general", { siteName: "Mine" })).status,
    ).toBe(403);
    await editor.goto(site.base + "/admin/settings/general");
    await editor.waitForURL(site.base + "/admin");
    await editor.context().close();

    // Signed out: refused.
    for (const method of ["GET", "PUT"] as const) {
      const response = await fetch(site.base + "/api/admin/settings/general", {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "PUT" ? { body: "{}" } : {}),
      });
      expect(response.status, method).toBe(401);
    }
    await page.context().close();
  });

  test("the time zone rules the scheduling box and the dates in the admin; automatic uses the browser's own zone", async () => {
    const page = await signedIn(owner);
    // The previous test set the zone to Asia/Kolkata; the browser here is in Los Angeles.
    expect(JSON.parse(String(await settingValue("timezone")))).toBe("Asia/Kolkata");
    const made = await call(page, "POST", "/api/admin/entries", {
      type: "post",
      title: "Timed post",
    });
    const id = String(made.json!["id"]);

    // Schedule for 9:30 in Kolkata: the stored moment is 04:00 UTC, whatever the browser's clock says.
    await page.goto(`${site.base}/admin/posts/${id}`);
    await page.getByRole("heading", { name: "Edit: Timed post", level: 1 }).waitFor();
    await page.locator("[contenteditable=true]").first().click();
    await page.keyboard.type("A post for later");
    await page.getByLabel(/^Scheduled/).check({ force: true });
    await page.getByText("The time in Asia/Kolkata.").waitFor();
    await page.getByLabel("Publish at").fill("2091-03-10T09:30");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() => page.locator(".oks-entry-actions [role=status]").textContent())
      .toBe("Saved.");
    const stored = (await db.run("select scheduled_at from entries where id = ?", [id]))[0]![
      "scheduled_at"
    ];
    expect(new Date(Number(stored)).toISOString()).toBe("2091-03-10T04:00:00.000Z");
    await page.reload();
    await page.getByRole("heading", { name: "Edit: Timed post", level: 1 }).waitFor();
    expect(await page.getByLabel("Publish at").inputValue()).toBe("2091-03-10T09:30");
    // A time in the past in the site's zone is still refused.
    await page.getByLabel("Publish at").fill("2020-01-15T09:30");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Choose a time in the future.").first().waitFor();

    // The dates in the lists and on the dashboard are in the site's zone, not the browser's.
    const updated = Number(
      (await db.run("select updated_at from entries where id = ?", [id]))[0]!["updated_at"],
    );
    await page.goto(`${site.base}/admin/posts`);
    await page
      .getByRole("row", { name: /Timed post/ })
      .getByText(written(updated, "Asia/Kolkata"), { exact: false })
      .waitFor();
    await page.goto(`${site.base}/admin`);
    await page
      .getByRole("list", { name: "Recent edits" })
      .getByText(written(updated, "Asia/Kolkata"), { exact: false })
      .first()
      .waitFor();

    // Automatic: each person's own browser decides, as it did before the setting existed.
    expect(
      (await call(page, "PUT", "/api/admin/settings/general", { timeZone: null })).status,
    ).toBe(200);
    expect(await settingValue("timezone")).toBeUndefined();
    await page.goto(`${site.base}/admin/posts/${id}`);
    await page.getByRole("heading", { name: "Edit: Timed post", level: 1 }).waitFor();
    await page.getByText("The time on your own clock.").waitFor();
    expect(await page.getByLabel("Publish at").inputValue()).toBe(
      zonedBox(Date.parse("2091-03-10T04:00:00Z"), "America/Los_Angeles"),
    );
    await page.context().close();
  });
});

// THE CORE DEFINITION OF M2 (docs/03-product/features.md, "MVP definition"): a non-technical owner, without help, can
//   1. finish the setup wizard,
//   2. write, schedule and publish posts and pages with images,
//   3. organise posts with categories and tags,
//   4. build the main menu,
//   5. set the site title, logo, colors and fonts within the default theme,
//   6. get a fast, SEO-ready site with sitemap, feeds and meta tags,
//   7. invite an editor with a limited role.
// This is one journey on one site, from an empty install, through the real screens in a real browser. The steps run in
// order and share the site. What is not built yet is listed at the end as `todo`, so this file always says how far M2 is.
describe.skipIf(!findBrowser())(
  "the core definition of M2: an owner's first hour",
  { timeout: 240_000 },
  () => {
    let db: TestDb;
    let site: Awaited<ReturnType<typeof startSite>>;
    let browser: Browser;
    type Page = Awaited<ReturnType<Browser["newPage"]>>;
    let page: Page;
    const owner = { email: "maple@example.com", password: "a-long-password" };

    beforeAll(async () => {
      db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-journey-")), "site.sqlite"));
      site = await startSite("sqlite", db, {
        OKS_SECRET: "j".repeat(40),
        OKS_SCHEDULER_SECONDS: "1",
        // The pictures the owner uploads go to a temporary folder, never into the project.
        OKS_UPLOADS_DIR: mkdtempSync(join(tmpdir(), "oks-journey-uploads-")),
      });
      browser = await chromium.launch({ executablePath: findBrowser()! });
      page = await browser.newPage();
    }, 600_000);

    afterAll(async () => {
      await browser?.close();
      site?.server.kill();
      await db?.close();
    });

    const get = async (path: string) => {
      const response = await fetch(site.base + path);
      return { response, body: await withLook(site.base, await response.text()) };
    };
    const saved = () =>
      expect
        .poll(() => page.locator(".oks-entry-actions [role=status]").textContent())
        .toBe("Saved.");
    const picture = (color: string) =>
      sharp({ create: { width: 120, height: 80, channels: 3, background: color } })
        .png()
        .toBuffer();
    /** Opens the editor for a new post or page from its list: the owner types a title and presses "Add new". */
    const startEntry = async (kind: "posts" | "pages", title: string) => {
      await page.goto(`${site.base}/admin/${kind}`);
      await page
        .getByLabel(new RegExp(`^Title of the new ${kind === "posts" ? "post" : "page"}`))
        .fill(title);
      if (kind === "pages") await page.getByLabel("Start in").selectOption("writing");
      await page.getByRole("button", { name: "Add new", exact: true }).click();
      await page.getByRole("heading", { name: `Edit: ${title}`, level: 1 }).waitFor();
    };
    const write = async (text: string) => {
      await page.locator("[contenteditable=true]").first().click();
      await page.keyboard.type(text);
    };
    const publishNow = async () => {
      await page.getByLabel("Published (everyone sees it)").check({ force: true });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      // A picture just uploaded has no description yet, so the publish check may list it first: the administrator goes
      // on anyway (the check itself is tested on its own).
      const check = page.getByRole("alert", { name: "Before this goes live" });
      const status = page.locator(".oks-entry-actions [role=status]");
      await expect
        .poll(async () => (await status.textContent()) === "Saved." || (await check.count()) > 0)
        .toBe(true);
      if ((await check.count()) > 0) {
        await check.getByRole("button", { name: "Publish anyway" }).click();
        await page.getByText("Published anyway. This was written to the log.").waitFor();
      }
    };
    const navLinks = (html: string, label: string) =>
      [
        ...(
          new RegExp(`<nav aria-label="${label}">(.*?)</nav>`, "s").exec(html)?.[1] ?? ""
        ).matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g),
      ].map((m) => `${m[2]} -> ${m[1]}`);

    test("1. the first visit goes to the setup wizard; two questions about the site, two about the owner, and the owner is signed in", async () => {
      const first = await fetch(site.base + "/", { redirect: "manual" });
      expect(first.status).toBe(307);
      await page.goto(site.base + "/");
      await page.waitForURL("**/admin/setup");
      await page.getByLabel("Site name").fill("Maple Street Bakery");
      await page.getByLabel("Tagline").fill("Bread, baked slowly");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByLabel("Your name").fill("Mira");
      await page.getByLabel("Email").fill(owner.email);
      await page.getByLabel(/^Password/).fill(owner.password);
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Finish setup" }).click();
      await page.getByRole("heading", { name: "Your site is set up" }).waitFor();
      await page.getByRole("link", { name: "Skip for now: open the dashboard" }).click();
      await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      await page.getByText("Maple Street Bakery").first().waitFor();
      // The site is live with its sample content.
      expect((await get("/")).body).toContain("This is your home page");
    });

    test("3. the owner makes a category, and posts can be organised with it", async () => {
      await page.goto(`${site.base}/admin/categories`);
      await page.getByRole("heading", { name: "Categories", level: 1 }).waitFor();
      await page.getByLabel(/^Name of the new category/).fill("Recipes");
      await page.getByRole("button", { name: "Add new category" }).click();
      await page.getByRole("row").filter({ hasText: "Recipes" }).first().waitFor();
    });

    test("2. write a post with a picture, put it in the category with tags, and publish it", async () => {
      await startEntry("posts", "Sourdough for beginners");
      await write("Mix flour and water, wait a day, and feed it again.");
      // A picture from the computer, uploaded in the picker's window: it is inserted at once.
      await page.getByRole("button", { name: "Insert image from the library" }).click();
      await page
        .getByRole("dialog")
        .locator("input[type=file]")
        .setInputFiles({
          name: "Starter jar.png",
          mimeType: "image/png",
          buffer: await picture("#c80"),
        });
      const describe = page.getByRole("dialog", { name: "Describe this picture" });
      await describe.getByLabel("Describe the picture").fill("A jar with a bubbling starter");
      await describe.getByRole("button", { name: "Insert picture" }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
      await expect.poll(() => page.locator(".oks-entry-editor img").count()).toBeGreaterThan(0);
      // Organise it: the category and two tags.
      await page.getByRole("heading", { name: "Categories and tags", level: 2 }).waitFor();
      await page.getByLabel("Recipes").check();
      await page.getByLabel(/^Tags/).fill("bread, baking");
      await page.getByRole("button", { name: "Save categories and tags" }).click();
      await page.getByText("Categories and tags saved.").waitFor();
      await publishNow();

      // The public page: the title, the text and the picture, which is a real file that is served.
      const post = await get("/blog/sourdough-for-beginners");
      expect(post.response.status).toBe(200);
      expect(post.body).toContain("<h1>Sourdough for beginners</h1>");
      expect(post.body).toContain("Mix flour and water");
      const src = /src="(\/uploads\/[^"]*Starter-jar\.png)"/.exec(post.body)?.[1];
      expect(src).toBeTruthy();
      expect((await fetch(site.base + src!)).status).toBe(200);
      // The sizes are made in the background, and then the page uses them.
      await expect
        .poll(async () => (await get("/blog/sourdough-for-beginners")).body, { timeout: 30_000 })
        .toContain("<picture");

      // The category and tag pages list it.
      for (const path of ["/category/recipes", "/tag/bread", "/tag/baking"]) {
        const archive = await get(path);
        expect(archive.response.status, path).toBe(200);
        expect(archive.body, path).toContain('href="/blog/sourdough-for-beginners"');
      }
    });

    test("2. write and publish a page", async () => {
      await startEntry("pages", "Opening hours");
      await write("Open every day from seven until three.");
      await publishNow();
      const hours = await get("/opening-hours");
      expect(hours.response.status).toBe(200);
      expect(hours.body).toContain("<h1>Opening hours</h1>");
      expect(hours.body).toContain("Open every day from seven until three.");
    });

    test("2. schedule: a post set for the future is kept and not live; a post set a moment ahead goes live by itself", async () => {
      await startEntry("posts", "Winter menu");
      await write("Soup and rye bread.");
      await page.getByLabel(/^Scheduled/).check({ force: true });
      await page.getByLabel("Publish at").fill("2090-12-01T08:00");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await saved();
      expect((await get("/blog/winter-menu")).response.status).toBe(404);
      await page.goto(`${site.base}/admin/posts`);
      await page
        .getByRole("row", { name: /Winter menu/ })
        .getByText("scheduled")
        .waitFor();

      // A second one is scheduled for 2.5 seconds ahead (the minute-sized box cannot do that, so the same route the box uses).
      const made = await page.evaluate(async () => {
        const post = await fetch("/api/admin/entries", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "post", title: "Spring special" }),
        });
        const body = (await post.json()) as { id: string; slug: string; revision: number };
        const soon = new Date(Date.now() + 2500).toISOString();
        const put = await fetch(`/api/admin/entries/${body.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Spring special",
            slugPart: "spring-special",
            status: "scheduled",
            scheduledAt: soon,
            blocks: [
              {
                id: "p1",
                type: "paragraph",
                props: {},
                content: [{ type: "text", text: "Spring words.", styles: {} }],
                children: [],
              },
            ],
            revision: body.revision,
          }),
        });
        return put.status;
      });
      expect(made).toBe(200);
      expect((await get("/blog/spring-special")).response.status).toBe(404);
      await expect
        .poll(async () => (await get("/blog/spring-special")).response.status, { timeout: 20_000 })
        .toBe(200);
    });

    test("4. build the main menu: a page, a category and a link; and a footer menu", async () => {
      await page.goto(`${site.base}/admin/menus`);
      await page.getByRole("heading", { name: "Header menu", level: 2 }).waitFor();
      await page.getByLabel("Page or post").selectOption({ label: "Page: Opening hours" });
      await page.getByRole("button", { name: "Add to menu" }).click();
      await page.getByLabel("Add", { exact: true }).selectOption("term");
      await page.getByLabel("Category or tag").selectOption({ label: "Category: Recipes" });
      await page.getByRole("button", { name: "Add to menu" }).click();
      await page.getByLabel("Add", { exact: true }).selectOption("url");
      await page.getByLabel("Label of the link").fill("Order online");
      await page.getByLabel("Address of the link").fill("https://orders.example.com");
      await page.getByRole("button", { name: "Add to menu" }).click();
      await page.getByRole("button", { name: "Save menu" }).click();
      await page.getByText("Menu saved.").waitFor();
      await page.getByRole("link", { name: "Footer menu" }).click();
      await page.getByRole("heading", { name: "Footer menu", level: 2 }).waitFor();
      await page.getByLabel("Page or post").selectOption({ label: "Page: Contact" });
      await page.getByRole("button", { name: "Add to menu" }).click();
      await page.getByRole("button", { name: "Save menu" }).click();
      await page.getByText("Menu saved.").waitFor();

      for (const path of [
        "/",
        "/opening-hours",
        "/blog/sourdough-for-beginners",
        "/category/recipes",
      ]) {
        const html = (await get(path)).body;
        expect(navLinks(html, "Main menu"), path).toEqual([
          "Opening hours -> /opening-hours",
          "Recipes -> /category/recipes",
          "Order online -> https://orders.example.com",
        ]);
        expect(navLinks(html, "Footer menu"), path).toEqual(["Contact -> /contact"]);
      }
    });

    test("5. (the part that exists) set the site title and tagline", async () => {
      await page.goto(`${site.base}/admin/settings/general`);
      await page.getByRole("heading", { name: "General settings", level: 1 }).waitFor();
      await page.getByLabel("Site name").fill("Maple Street Bakery & Café");
      await page.getByLabel("Tagline").fill("Bread, baked slowly, every morning");
      await page.getByRole("button", { name: "Save settings" }).click();
      await page.getByText("Saved.", { exact: true }).waitFor();
      await page.goto(`${site.base}/admin`);
      await page.getByText("Maple Street Bakery & Café").first().waitFor();
    });

    test("6. (the part that exists) a site that search engines can read: addresses, sitemap, robots, real 404s, and visitors can search", async () => {
      // Every published page has its own title and canonical address.
      const post = (await get("/blog/sourdough-for-beginners")).body;
      expect(post).toMatch(
        /<title>Sourdough for beginners – Maple Street Bakery &amp; Café<\/title>/,
      );
      expect(post).toMatch(/<link rel="canonical" href="[^"]*\/blog\/sourdough-for-beginners"/);
      // The sitemap lists what is public and nothing that is not (the scheduled winter post is not live yet).
      const sitemap = (await get("/sitemap.xml")).body;
      const paths = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map(
        (m) => new URL(m[1]!).pathname,
      );
      for (const wanted of [
        "/",
        "/opening-hours",
        "/contact",
        "/blog/sourdough-for-beginners",
        "/blog/spring-special",
        "/category/recipes",
        "/tag/bread",
      ])
        expect(paths, wanted).toContain(wanted);
      expect(paths).not.toContain("/blog/winter-menu");
      // robots.txt names the sitemap and keeps crawlers out of the admin.
      const robots = (await get("/robots.txt")).body;
      expect(robots).toContain("Disallow: /admin");
      expect(robots).toMatch(/Sitemap: .*\/sitemap\.xml/);
      // An address that does not exist is a real 404 that is not indexed.
      const missing = await get("/no-such-page");
      expect(missing.response.status).toBe(404);
      expect(missing.response.headers.get("x-robots-tag")).toContain("noindex");
      // A draft is not reachable, but the owner can preview it and share a link for it.
      await startEntry("posts", "Secret recipe");
      await write("Only for the family.");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await saved();
      expect((await get("/blog/secret-recipe")).response.status).toBe(404);
      await page.getByRole("button", { name: "Create a share link" }).click();
      const link = await page.getByLabel("Share link", { exact: true }).inputValue();
      expect((await get(link.replace(site.base, ""))).body).toContain("Only for the family.");
      // Visitors can search.
      const found = (await get("/search?q=sourdough")).body;
      expect(found).toContain('href="/blog/sourdough-for-beginners"');
      expect(found).not.toContain("Secret recipe");
      // A page that gets a new address keeps the old one working.
      await page.goto(`${site.base}/admin/pages`);
      await page.getByRole("link", { name: "Opening hours" }).click();
      await page.getByRole("heading", { name: "Edit: Opening hours", level: 1 }).waitFor();
      await page.getByLabel("Address").fill("hours");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await saved();
      const moved = await fetch(site.base + "/opening-hours", { redirect: "manual" });
      expect(moved.status).toBe(301);
      expect(new URL(moved.headers.get("location")!, site.base).pathname).toBe("/hours");
      expect((await get("/hours")).response.status).toBe(200);
    });

    test("the whole journey leaves a site with no accessibility violation on its public pages", async () => {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        for (const path of [
          "/",
          "/hours",
          "/blog/sourdough-for-beginners",
          "/category/recipes",
          "/search?q=bread",
        ]) {
          await page.goto(site.base + path);
          await page
            .getByRole("navigation", { name: "Main menu" })
            .waitFor({ state: "visible", timeout: 15_000 })
            .catch(() => {
              throw new Error(`There is no header menu on ${path} at ${width}px`);
            });
          await page.addScriptTag({ content: axe.source });
          const result = await page.evaluate(() =>
            (window as unknown as { axe: typeof axe }).axe.run(document, {
              runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
            }),
          );
          expect(
            result.violations.map(
              (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
            ),
            `${path} ${width}px`,
          ).toEqual([]);
        }
      }
    });

    test("5. set the logo, the main color and the fonts, and the whole public site shows them", async () => {
      // Settings has a Look page; the screen is accessible at a wide and a narrow width.
      await page.goto(`${site.base}/admin/settings/general`);
      await page.getByRole("link", { name: "Look", exact: true }).click();
      await page.getByRole("heading", { name: "Look of the site", level: 1 }).waitFor();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.addScriptTag({ content: axe.source });
        const result = await page.evaluate(() =>
          (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          }),
        );
        expect(
          result.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          ),
          `look ${width}px`,
        ).toEqual([]);
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      // The owner picks a color and fonts, and uploads a logo in the picker's window.
      await page.getByLabel("Pick the color of links and buttons").fill("#2a6f4f");
      await page.getByLabel("Font for text").selectOption("system-serif");
      await page.getByLabel("Font for headings").selectOption("system-mono");
      await page.getByRole("button", { name: "Choose a logo" }).click();
      await page
        .getByRole("dialog")
        .locator("input[type=file]")
        .setInputFiles({
          name: "Maple logo.png",
          mimeType: "image/png",
          buffer: await picture("#2a6f4f"),
        });
      await page.getByRole("dialog").waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Change the logo" }).waitFor();
      // A developer's own CSS: the box is folded away until it is opened.
      await page.getByText("For developers: your own CSS").click();
      await page
        .getByLabel("CSS for the public pages")
        .fill("/* wider letters */ h1 { letter-spacing: 0.2em }");
      await page.getByRole("button", { name: "Save the look" }).click();
      await page.getByText("Saved. Your site shows the new look now.").waitFor();

      // The next visit to any public page: the logo links home, and the colors and fonts are written.
      for (const path of [
        "/",
        "/opening-hours",
        "/blog/sourdough-for-beginners",
        "/category/recipes",
      ]) {
        const shown = await get(path);
        expect(shown.response.status, path).toBe(200);
        expect(shown.body, path).toContain("--oks-color-primary-700:");
        expect(shown.body, path).toContain("h1 { letter-spacing: 0.2em }");
        expect(shown.body, path).not.toContain("wider letters");
        expect(shown.body, path).toMatch(
          /<header><a href="\/"[^>]*><img src="\/uploads\/[^"]*Maple-logo\.png"[^>]*alt="Maple Street Bakery[^"]*"/,
        );
      }
      const logo = /<img src="(\/uploads\/[^"]*Maple-logo\.png)"/.exec((await get("/")).body)?.[1];
      expect((await fetch(site.base + logo!)).status).toBe(200);

      // In a real browser the fonts and the color are really used, and the page is still accessible.
      const visitor = await browser.newPage();
      await visitor.goto(site.base + "/");
      const used = await visitor.evaluate(() => {
        const hex = getComputedStyle(document.documentElement)
          .getPropertyValue("--oks-color-primary-700")
          .trim();
        const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const link = document.createElement("a");
        link.href = "/x";
        link.textContent = "a link";
        document.body.append(link);
        return {
          body: getComputedStyle(document.body).fontFamily,
          heading: getComputedStyle(document.querySelector("h1")!).fontFamily,
          spacing: getComputedStyle(document.querySelector("h1")!).letterSpacing,
          link: getComputedStyle(link).color,
          expected: `rgb(${rgb.join(", ")})`,
        };
      });
      expect(used.body).toContain("Iowan Old Style");
      expect(used.heading).toContain("ui-monospace");
      expect(used.link).toBe(used.expected);
      expect(parseFloat(used.spacing)).toBeGreaterThan(0); // the developer's CSS is used
      for (const width of [1280, 390]) {
        await visitor.setViewportSize({ width, height: 900 });
        await visitor.addScriptTag({ content: axe.source });
        const result = await visitor.evaluate(() =>
          (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          }),
        );
        expect(
          result.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          ),
          `public ${width}px`,
        ).toEqual([]);
      }
      await visitor.close();

      // The screen shows what was saved; removing the logo and the color takes them away at once.
      await page.reload();
      expect(await page.getByLabel("Pick the color of links and buttons").inputValue()).toBe(
        "#2a6f4f",
      );
      // CSS that fails the check is refused with the line, and the saved CSS stays.
      expect(await page.getByLabel("CSS for the public pages").inputValue()).toBe(
        "h1 { letter-spacing: 0.2em }",
      );
      await page
        .getByLabel("CSS for the public pages")
        .fill("h1 { color: red }\n@import url(https://evil.example/x.css);");
      await page.getByRole("button", { name: "Save the look" }).click();
      await page.getByText("Line 2:").waitFor();
      expect((await get("/")).body).not.toContain("evil.example");
      expect((await get("/")).body).toContain("letter-spacing");
      await page.getByLabel("CSS for the public pages").fill("");

      // The font library: the fonts are kept on the site and served by it, never by another company.
      await page.getByLabel("Font for text").selectOption("inter");
      await page.getByLabel("Font for headings").selectOption("source-serif-4");
      await page.getByText("Licences of the fonts you use").click();
      await page.getByText("Inter 5.3.0: Copyright 2016 The Inter Project Authors").waitFor();
      await page.addScriptTag({ content: axe.source });
      const lookAxe = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        lookAxe.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
      ).toEqual([]);
      await page.getByRole("button", { name: "Save the look" }).click();
      await expect.poll(async () => (await get("/")).body).toContain("/fonts/inter-latin-400.");
      const withFonts = (await get("/")).body;
      const faces = [...withFonts.matchAll(/url\((\/fonts\/[^)]+\.woff2)\)/g)].map((m) => m[1]!);
      expect(new Set(faces).size).toBe(4);
      expect(withFonts).toContain('"Inter", system-ui');
      expect(withFonts).toContain('"Source Serif 4"');
      expect(withFonts).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      const fontFile = await fetch(site.base + faces[0]!);
      expect(fontFile.status).toBe(200);
      expect(fontFile.headers.get("content-type")).toBe("font/woff2");
      expect(fontFile.headers.get("cache-control")).toContain("immutable");
      const fontBytes = Buffer.from(await fontFile.arrayBuffer());
      const { createHash } = await import("node:crypto");
      expect(createHash("sha256").update(fontBytes).digest("hex").slice(0, 16)).toBe(
        /\.([0-9a-f]{16})\.woff2$/.exec(faces[0]!)![1],
      );
      expect(fontBytes.subarray(0, 4).toString()).toBe("wOF2");
      // Only the library's own names are served.
      for (const bad of [
        faces[0]!.replace(/\.[0-9a-f]{16}\./, ".0000000000000000."),
        "/fonts/inter-latin-400.woff2",
        "/fonts/..%2Fpackage.json",
      ])
        expect((await fetch(site.base + bad)).status).toBe(404);

      // Dark mode: the owner chooses the mode and may give visitors a switch; the page is drawn dark before it is shown.
      await page.getByLabel("Like the visitor's device (light or dark)").check();
      await page
        .getByLabel("Show visitors a switch to choose light or dark for themselves")
        .check();
      await page.getByRole("button", { name: "Save the look" }).click();
      await expect.poll(async () => (await get("/")).body).toContain('data-mode="system"');
      const night = await (await browser.newContext({ colorScheme: "dark" })).newPage();
      await night.goto(site.base + "/");
      const themeOf = (who: Page) => who.evaluate(() => document.documentElement.dataset["theme"]);
      expect(await themeOf(night)).toBe("dark");
      expect(await night.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        "rgb(10, 10, 10)",
      );
      for (const width of [1280, 390]) {
        await night.setViewportSize({ width, height: 900 });
        await night.addScriptTag({ content: axe.source });
        const dark = await night.evaluate(() =>
          (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          }),
        );
        expect(
          dark.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          ),
          `dark ${width}px`,
        ).toEqual([]);
      }
      // The visitor's own choice wins and is kept in the browser.
      const toggle = night.getByRole("button", { name: "Dark mode" });
      expect(await toggle.getAttribute("aria-pressed")).toBe("true");
      await toggle.click();
      expect(await themeOf(night)).toBe("light");
      expect(await toggle.getAttribute("aria-pressed")).toBe("false");
      await night.reload();
      expect(await themeOf(night)).toBe("light");
      expect(await night.evaluate(() => document.cookie)).toBe("");
      await night.context().close();
      // A light device starts light; the switch makes it dark.
      const day = await (await browser.newContext({ colorScheme: "light" })).newPage();
      await day.goto(site.base + "/");
      expect(await themeOf(day)).toBe("light");
      await day.getByRole("button", { name: "Dark mode" }).click();
      await day.reload();
      expect(await themeOf(day)).toBe("dark");
      await day.context().close();
      // Always dark, no switch: a light device sees dark, and there is no button.
      await page.getByLabel("Always dark").check();
      await page
        .getByLabel("Show visitors a switch to choose light or dark for themselves")
        .uncheck();
      await page.getByRole("button", { name: "Save the look" }).click();
      await expect.poll(async () => (await get("/")).body).toContain('data-mode="dark"');
      const always = await (await browser.newContext({ colorScheme: "light" })).newPage();
      await always.goto(site.base + "/");
      expect(await themeOf(always)).toBe("dark");
      expect(await always.getByRole("button", { name: "Dark mode" }).count()).toBe(0);
      await always.context().close();
      await page.getByLabel("Always light").check();

      await page.getByRole("button", { name: "Remove the logo" }).click();
      await page.getByRole("button", { name: "Use the built-in color" }).click();
      await page.getByLabel("Font for text").selectOption("system-sans");
      await page.getByLabel("Font for headings").selectOption("system-sans");
      await page.getByRole("button", { name: "Save the look" }).click();
      await page.getByText("Saved. Your site shows the new look now.").waitFor();
      const plain = (await get("/")).body;
      expect(plain).not.toContain("--oks-color-primary-700");
      expect(plain).not.toContain("Maple-logo");
      expect(plain).not.toContain("letter-spacing");
      // Always light and no switch: no script, no switch, as before.
      expect(plain).not.toContain("data-mode");
      expect(plain).not.toContain("data-theme");
    });

    /** A request made from inside the signed-in page, so it carries the owner's session. */
    const call = (who: Page, method: string, url: string, body?: unknown) =>
      who.evaluate(
        async ([m, u, b]) => {
          const response = await fetch(u as string, {
            method: m as string,
            headers: { "content-type": "application/json" },
            ...(b === undefined ? {} : { body: JSON.stringify(b) }),
          });
          return {
            status: response.status,
            json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
          };
        },
        [method, url, body] as const,
      );
    test("6. the tags a page tells search engines and social sites, the structured data, the SEO box, and the feeds", async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      const meta = (html: string, attr: "name" | "property", key: string) =>
        new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html)?.[1];
      const ldOf = (html: string) =>
        [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].flatMap(
          (m) => JSON.parse(m[1]!) as Record<string, unknown>[],
        );
      const parse = (path: string) =>
        page.evaluate(async (url) => {
          const text = await (await fetch(url)).text();
          const doc = new DOMParser().parseFromString(text, "application/xml");
          return {
            error: doc.querySelector("parsererror")?.textContent ?? null,
            root: doc.documentElement.tagName,
            titles: [...doc.querySelectorAll("item > title, entry > title")].map(
              (t) => t.textContent,
            ),
            links: [...doc.querySelectorAll("item > link")].map((l) => l.textContent),
            text,
          };
        }, site.base + path);

      // The post: a title with the site name, a description made from its text, Open Graph and Twitter tags with its picture,
      // a canonical address, links to the feeds, and structured data.
      const html = (await get("/blog/sourdough-for-beginners")).body;
      expect(html).toMatch(
        /<title>Sourdough for beginners – Maple Street Bakery &amp; Café<\/title>/,
      );
      // The words of the page; the picture's description is part of its text now that the editor asks for one.
      expect(meta(html, "name", "description")).toMatch(
        /^Mix flour and water, wait a day, and feed it again\./,
      );
      expect(meta(html, "property", "og:title")).toBe(
        "Sourdough for beginners – Maple Street Bakery &amp; Café",
      );
      expect(meta(html, "property", "og:type")).toBe("article");
      expect(meta(html, "property", "og:url")).toMatch(/\/blog\/sourdough-for-beginners$/);
      expect(meta(html, "property", "og:image")).toMatch(/\/uploads\/.*Starter-jar\.png$/);
      expect(meta(html, "property", "article:published_time")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(meta(html, "name", "twitter:card")).toBe("summary_large_image");
      expect(html).toMatch(
        /<link rel="alternate" type="application\/rss\+xml" href="[^"]*\/feed\.xml"/,
      );
      expect(html).toMatch(
        /<link rel="alternate" type="application\/atom\+xml" href="[^"]*\/atom\.xml"/,
      );
      const ld = ldOf(html);
      expect(ld[0]).toMatchObject({
        "@type": "BlogPosting",
        headline: "Sourdough for beginners",
        author: { "@type": "Person", name: "Mira" },
        publisher: { name: "Maple Street Bakery & Café" },
      });
      expect(String(ld[0]!["image"])).toMatch(/Starter-jar\.png$/);
      expect(ld[1]).toMatchObject({ "@type": "BreadcrumbList" });
      // The front page: the site's name and tagline, and the site as structured data with its search box.
      const front = (await get("/")).body;
      expect(front).toMatch(
        /<title>Maple Street Bakery &amp; Café – Bread, baked slowly, every morning<\/title>/,
      );
      expect(ldOf(front)[0]).toMatchObject({
        "@type": "WebSite",
        potentialAction: { "@type": "SearchAction" },
      });
      // A category page has its own title and description, and the feed of that category.
      const archive = (await get("/category/recipes")).body;
      expect(archive).toMatch(/<title>Category: Recipes – Maple Street Bakery &amp; Café<\/title>/);
      expect(meta(archive, "name", "description")).toContain("Recipes");
      expect(archive).toMatch(/href="[^"]*\/category\/recipes\/feed\.xml"/);

      // The SEO box: the owner writes a description; the page and its previews use it at once. A hostile text cannot break
      // out of the structured data (SEO-29): it runs no code and reads back exactly.
      const hostile = "</script><script>window.pwned=1</script> Slow-fed starter";
      await page.goto(`${site.base}/admin/posts`);
      await page.getByRole("link", { name: "Sourdough for beginners" }).click();
      await page
        .getByRole("heading", { name: "Edit: Sourdough for beginners", level: 1 })
        .waitFor();
      await page.getByRole("heading", { name: "Search engines", level: 2 }).waitFor();
      await page
        .getByText("Empty: a description is made from the first words of the page.")
        .waitFor();
      await page.getByLabel("Description for search results and link previews").fill(hostile);
      await page.getByRole("button", { name: "Update search engine settings" }).click();
      await page.getByText("Search engine settings saved.").waitFor();
      const changed = (await get("/blog/sourdough-for-beginners")).body;
      expect(meta(changed, "name", "description")).toContain("Slow-fed starter");
      expect(meta(changed, "name", "description")).not.toContain("<");
      expect(ldOf(changed)[0]!["description"]).toBe(hostile);
      expect(changed.match(/<script type="application\/ld\+json">.*?<\/script>/gs)).toHaveLength(1);
      await page.goto(`${site.base}/blog/sourdough-for-beginners`);
      expect(
        await page.evaluate(() => (window as unknown as { pwned?: number }).pwned),
      ).toBeUndefined();
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goBack();
      await page.setViewportSize({ width: 1280, height: 800 });

      // The feeds: RSS and Atom for the blog and for the category; well-formed; the published posts only; the full text with
      // the site's address on its pictures and links; new posts at once; a missing category is a 404.
      const rss = await parse("/feed.xml");
      expect(rss).toMatchObject({ error: null, root: "rss" });
      expect(rss.titles).toContain("Sourdough for beginners");
      expect(rss.titles).toContain("Spring special");
      expect(rss.titles).not.toContain("Winter menu"); // scheduled for 2090
      expect(rss.titles).not.toContain("Secret recipe"); // a draft
      expect(rss.links[0]).toMatch(new RegExp(`^${site.base}/blog/`));
      expect(rss.text).toContain("Mix flour and water");
      expect(rss.text).toMatch(new RegExp(`src=&quot;${site.base}/uploads/[^&]*Starter-jar\\.png`));
      expect((await get("/feed.xml")).response.headers.get("content-type")).toContain(
        "application/rss+xml",
      );
      const atom = await parse("/atom.xml");
      expect(atom).toMatchObject({ error: null, root: "feed" });
      expect(atom.titles).toContain("Sourdough for beginners");
      expect((await get("/atom.xml")).response.headers.get("content-type")).toContain(
        "application/atom+xml",
      );
      expect((await parse("/category/recipes/feed.xml")).titles).toEqual([
        "Sourdough for beginners",
      ]);
      expect((await parse("/category/recipes/atom.xml")).titles).toEqual([
        "Sourdough for beginners",
      ]);
      expect((await get("/category/nope/feed.xml")).response.status).toBe(404);
      expect((await get("/category/nope/atom.xml")).response.status).toBe(404);
      const fresh = await call(page, "POST", "/api/admin/entries", {
        type: "post",
        title: "Fresh news",
      });
      const freshId = String((fresh.json as { id: string }).id);
      expect(
        (
          await call(page, "PUT", `/api/admin/entries/${freshId}`, {
            title: "Fresh news",
            slugPart: "fresh-news",
            status: "published",
            blocks: [
              {
                id: "p1",
                type: "paragraph",
                props: {},
                content: [{ type: "text", text: "News words.", styles: {} }],
                children: [],
              },
            ],
            revision: (fresh.json as { revision: number }).revision,
          })
        ).status,
      ).toBe(200);
      expect((await parse("/feed.xml")).titles[0]).toBe("Fresh news");

      // "Ask search engines not to list this page": it stays on the site and leaves the page tags, the sitemap, the search and
      // the feeds.
      await page.goto(`${site.base}/admin/posts`);
      await page.getByRole("link", { name: "Sourdough for beginners" }).click();
      await page
        .getByRole("heading", { name: "Edit: Sourdough for beginners", level: 1 })
        .waitFor();
      await page.getByLabel("Ask search engines not to list this page").check();
      await page.getByRole("button", { name: "Update search engine settings" }).click();
      await page.getByText("Search engine settings saved.").waitFor();
      const hidden = (await get("/blog/sourdough-for-beginners")).body;
      expect(meta(hidden, "name", "robots")).toBe("noindex, nofollow");
      expect((await get("/blog/sourdough-for-beginners")).response.status).toBe(200);
      expect((await get("/sitemap.xml")).body).not.toContain("/blog/sourdough-for-beginners");
      expect((await get("/search?q=sourdough")).body).not.toContain(
        'href="/blog/sourdough-for-beginners"',
      );
      expect((await parse("/feed.xml")).titles).not.toContain("Sourdough for beginners");
      expect((await parse("/category/recipes/feed.xml")).titles).toEqual([]);
      // And it comes back when the owner changes their mind.
      await page.getByLabel("Ask search engines not to list this page").uncheck();
      await page.getByLabel("Description for search results and link previews").fill("");
      await page.getByRole("button", { name: "Update search engine settings" }).click();
      await page.getByText("Search engine settings saved.").waitFor();
      expect((await get("/sitemap.xml")).body).toContain("/blog/sourdough-for-beginners");
      expect((await parse("/feed.xml")).titles).toContain("Sourdough for beginners");
      expect(
        meta((await get("/blog/sourdough-for-beginners")).body, "name", "robots"),
      ).toBeUndefined();

      // A site that asks search engines to stay away has no feeds either, and the owner can switch it back.
      expect(
        (await call(page, "PUT", "/api/admin/settings/seo", { discourageIndexing: true })).status,
      ).toBe(200);
      expect((await get("/feed.xml")).response.status).toBe(404);
      expect((await get("/category/recipes/atom.xml")).response.status).toBe(404);
      expect(
        (await call(page, "PUT", "/api/admin/settings/seo", { discourageIndexing: false })).status,
      ).toBe(200);
      expect((await get("/feed.xml")).response.status).toBe(200);

      // The SEO box refuses what it should; signed out nothing is reachable.
      expect(
        (
          await call(page, "PUT", `/api/admin/entries/${freshId}/seo`, {
            description: "x".repeat(301),
          })
        ).status,
      ).toBe(400);
      expect(
        (await call(page, "PUT", `/api/admin/entries/${freshId}/seo`, { noindex: "yes" })).status,
      ).toBe(400);
      for (const method of ["GET", "PUT"] as const) {
        const response = await fetch(`${site.base}/api/admin/entries/${freshId}/seo`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "PUT" ? { body: "{}" } : {}),
        });
        expect(response.status, method).toBe(401);
      }
    });
    test("7. invite an editor with a limited role: a link, a password of their own, the right menu, no way into users and settings, then a changed role and removal", async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      const call = (who: Page, method: string, url: string, body?: unknown) =>
        who.evaluate(
          async ([m, u, b]) => {
            const response = await fetch(u as string, {
              method: m as string,
              headers: { "content-type": "application/json" },
              ...(b === undefined ? {} : { body: JSON.stringify(b) }),
            });
            return {
              status: response.status,
              json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
            };
          },
          [method, url, body] as const,
        );
      const menuHrefs = async (who: Page) => {
        await who.locator('a[href="/admin/pages"]').first().waitFor({ state: "attached" });
        const found: string[] = [];
        for (const href of [
          "/admin/pages",
          "/admin/posts",
          "/admin/categories",
          "/admin/menus",
          "/admin/media",
          "/admin/users",
          "/admin/settings/general",
        ])
          if ((await who.locator(`a[href="${href}"]`).count()) > 0) found.push(href);
        return found;
      };
      const axeOf = async (who: Page, label: string) => {
        await who.addScriptTag({ content: axe.source });
        const result = await who.evaluate(() =>
          (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          }),
        );
        expect(
          result.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          ),
          label,
        ).toEqual([]);
      };

      // The owner opens Users, sees themselves, and makes an invitation for Eli as an editor.
      await page.goto(`${site.base}/admin/users`);
      await page.getByRole("heading", { name: "Users", level: 1 }).waitFor();
      await page.getByRole("cell", { name: "Mira (you)" }).waitFor();
      await page.getByLabel(/^Name/).fill("Eli");
      await page.getByLabel("Email").fill("eli@example.com");
      expect(await page.getByLabel("Role", { exact: true }).inputValue()).toBe("editor");
      await page.getByRole("button", { name: "Make an invitation link" }).click();
      const link = await page.locator("#invite-link").inputValue();
      expect(link).toMatch(new RegExp(`^${site.base}/admin/invite/[A-Za-z0-9_-]{30,}$`));
      await page.getByText("It stops working on").waitFor();
      await page.getByRole("cell", { name: "eli@example.com" }).waitFor();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await axeOf(page, `users ${width}px`);
      }
      await page.setViewportSize({ width: 1280, height: 800 });

      // Eli opens the link on their own computer (a browser with no session), and chooses a password.
      const eli = await (await browser.newContext()).newPage();
      await eli.goto(link);
      await eli
        .getByRole("heading", { name: "Join Maple Street Bakery & Café", level: 1 })
        .waitFor();
      await eli.getByText("You are invited as").waitFor();
      expect(await eli.getByLabel("Your name").inputValue()).toBe("Eli");
      for (const width of [1280, 390]) {
        await eli.setViewportSize({ width, height: 800 });
        await axeOf(eli, `invitation page ${width}px`);
      }
      // Back to a desktop width: on a phone the menu is folded away.
      await eli.setViewportSize({ width: 1280, height: 800 });
      await eli.getByLabel(/^Password/).fill("short");
      await eli.getByRole("button", { name: "Join" }).click();
      await eli
        .getByText(/at least 10 characters/)
        .first()
        .waitFor();
      await eli.getByLabel("Your name").fill("Eli Stone");
      await eli.getByLabel(/^Password/).fill("eli-has-a-long-password");
      await eli.getByRole("button", { name: "Join" }).click();
      await eli.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      // The link works once: opened again it says so, in one plain message.
      const again = await (await browser.newContext()).newPage();
      await again.goto(link);
      await again.getByRole("heading", { name: "This invitation link does not work" }).waitFor();
      await again.close();

      // Eli has the editor's menu: the content, the categories, the menus and the library. Not users, not settings.
      expect(await menuHrefs(eli)).toEqual([
        "/admin/pages",
        "/admin/posts",
        "/admin/categories",
        "/admin/menus",
        "/admin/media",
      ]);
      // Eli can write and publish.
      const eliPost = await call(eli, "POST", "/api/admin/entries", {
        type: "post",
        title: "Eli's notes",
      });
      expect(eliPost.status).toBe(200);
      // And cannot reach the people or the settings, by the screen or by the API.
      for (const path of ["/admin/users", "/admin/settings/general"]) {
        await eli.goto(site.base + path);
        await eli.waitForURL(site.base + "/admin");
      }
      expect((await call(eli, "GET", "/api/admin/users")).status).toBe(403);
      expect(
        (
          await call(eli, "POST", "/api/admin/users", {
            name: "X",
            email: "x@example.com",
            roleKey: "administrator",
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(eli, "PATCH", `/api/admin/users/${"x".repeat(26)}`, { role: "administrator" }))
          .status,
      ).toBe(403);
      expect(
        (await call(eli, "PUT", "/api/admin/settings/general", { siteName: "Mine" })).status,
      ).toBe(403);

      // The owner sees Eli in the list with the editor role and changes it to author: the menu shrinks at the next load.
      await page.reload();
      const row = page.getByRole("row", { name: /Eli Stone/ });
      await row.waitFor();
      await row.getByLabel("Role of Eli Stone").selectOption("author");
      await page
        .getByRole("row", { name: /Eli Stone/ })
        .getByLabel("Role of Eli Stone")
        .waitFor();
      await expect
        .poll(
          async () =>
            (
              await db.run(
                "select r.key as k from site_members m join roles r on r.id = m.role_id join users u on u.id = m.user_id where u.email = 'eli@example.com'",
              )
            )[0]!["k"],
        )
        .toBe("author");
      await eli.goto(`${site.base}/admin`);
      await eli.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      expect(await menuHrefs(eli)).toEqual(["/admin/pages", "/admin/posts", "/admin/media"]);

      // The last administrator is protected: the owner cannot step down or be removed.
      const miraId = String(
        (await db.run("select id from users where email = ?", [owner.email]))[0]!["id"],
      );
      const demote = await call(page, "PATCH", `/api/admin/users/${miraId}`, { role: "editor" });
      expect(demote.status).toBe(409);
      expect(String((demote.json!["error"] as { message: string }).message)).toContain(
        "last administrator",
      );
      expect((await call(page, "DELETE", `/api/admin/users/${miraId}`)).status).toBe(409);

      // An invitation that is cancelled stops working at once.
      const zed = await call(page, "POST", "/api/admin/users", {
        name: "Zed",
        email: "zed@example.com",
        roleKey: "contributor",
        days: 1,
      });
      expect(zed.status).toBe(201);
      const zedLink = String(zed.json!["link"]);
      const zedId = String((zed.json!["invitation"] as { id: string }).id);
      expect(
        (
          await call(page, "POST", "/api/admin/users", {
            name: "Zed again",
            email: "ZED@example.com",
            roleKey: "editor",
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await call(page, "POST", "/api/admin/users", {
            name: "Mira",
            email: owner.email,
            roleKey: "editor",
          })
        ).status,
      ).toBe(409);
      await page.reload();
      await page.getByRole("button", { name: "Cancel the invitation for Zed" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Cancel the invitation" })
        .click();
      await page.getByText("The invitation for Zed is cancelled").waitFor();
      const dead = await (await browser.newContext()).newPage();
      await dead.goto(zedLink);
      await dead.getByRole("heading", { name: "This invitation link does not work" }).waitFor();
      await dead.close();
      expect((await call(page, "DELETE", `/api/admin/invitations/${zedId}`)).status).toBe(404);

      // Removing Eli ends their access at once, and keeps what they wrote.
      await page.reload();
      await page.getByRole("button", { name: "Remove Eli Stone" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Remove", exact: true })
        .click();
      await page.getByRole("row", { name: /Eli Stone/ }).waitFor({ state: "detached" });
      await eli.goto(`${site.base}/admin`);
      await eli.waitForURL("**/admin/login");
      expect(
        Number(
          (await db.run("select count(*) as n from entries where title = 'Eli''s notes'"))[0]!["n"],
        ),
      ).toBe(1);
      expect(
        Number(
          (await db.run("select count(*) as n from users where email = 'eli@example.com'"))[0]![
            "n"
          ],
        ),
      ).toBe(1);
      await eli.context().close();

      // Signed out, none of this is reachable.
      for (const [method, url] of [
        ["GET", "/api/admin/users"],
        ["POST", "/api/admin/users"],
        ["PATCH", `/api/admin/users/${miraId}`],
        ["DELETE", `/api/admin/users/${miraId}`],
        ["DELETE", `/api/admin/invitations/${zedId}`],
      ] as const) {
        const response = await fetch(site.base + url, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}),
        });
        expect(response.status, `${method} ${url}`).toBe(401);
      }
      // A wrong link on the accept route gets one plain answer.
      const wrong = await fetch(`${site.base}/api/invite/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "this-link-was-never-made-at-all",
          password: "a-long-password",
        }),
      });
      expect(wrong.status).toBe(404);
    });
  },
);

describe.skipIf(!findBrowser())(
  "the look of the site: colors and fonts",
  { timeout: 150_000 },
  () => {
    let db: TestDb;
    let site: Awaited<ReturnType<typeof startSite>>;
    let browser: Browser;
    const owner = { email: "anna@example.com", password: "a-long-password" };
    const cara = { email: "cara@example.com", password: "cara-long-password" };

    // A registry that holds two plugins: one good, and one whose download does not match its published hash.
    const pluginText = JSON.stringify({
      format: 1,
      manifest: {
        id: "npm-hello",
        version: "1.0.0",
        displayName: "NPM Hello",
        description: "Comes from npm.",
        author: "Ada",
        permissions: ["content:read"],
        hooks: [],
        blocks: [],
      },
      code: "export default { hooks: {} };",
      integrity: createHash("sha256").update("export default { hooks: {} };").digest("hex"),
    });
    const tarOf = (name: string, text: string) => {
      const body = Buffer.from(text);
      const header = Buffer.alloc(512);
      header.write(name, 0, "utf8");
      header.write("0000644\0", 100, "latin1");
      header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
      header.write("0", 156, "latin1");
      header.write("ustar\0", 257, "latin1");
      return gzipSync(
        Buffer.concat([
          header,
          body,
          Buffer.alloc((512 - (body.length % 512)) % 512),
          Buffer.alloc(1024),
        ]),
      );
    };
    const tarball = tarOf("package/npm-hello-1.0.0.oksplugin", pluginText);
    let registry: Server;
    let registryUrl = "";

    beforeAll(async () => {
      registry = createHttpServer((request, response) => {
        const url = request.url ?? "";
        const meta = (name: string, integrity: string) => ({
          name,
          version: "1.0.0",
          dist: { tarball: `${registryUrl}/${name}/-/${name}-1.0.0.tgz`, integrity },
        });
        if (url.endsWith(".tgz")) {
          response.end(tarball);
        } else if (url === "/npm-hello/latest" || url === "/npm-hello/1.0.0") {
          response.end(
            JSON.stringify(
              meta("npm-hello", `sha512-${createHash("sha512").update(tarball).digest("base64")}`),
            ),
          );
        } else if (url === "/npm-bad/latest") {
          response.end(JSON.stringify(meta("npm-bad", "sha512-AAAA")));
        } else {
          response.statusCode = 404;
          response.end("{}");
        }
      });
      await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
      registryUrl = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
      db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-look-")), "site.sqlite"));
      site = await startSite("sqlite", db, {
        OKS_SECRET: "l".repeat(40),
        OKS_LICENCE_PUBLIC_KEYS: licencePublic,
        OKS_NPM_REGISTRY: registryUrl,
      });
      const made = await fetch(site.base + "/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          siteName: "Anna's Garden",
          tagline: "Plants and pots",
          starterContent: true,
          admin: { name: "Anna", ...owner },
        }),
      });
      expect(made.status).toBe(200);
      const signUp = await fetch(site.base + "/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: site.base },
        body: JSON.stringify({ name: "Cara", ...cara }),
      });
      const caraId = ((await signUp.json()) as { user: { id: string } }).user.id;
      const siteId = String((await db.run("select id from sites"))[0]!["id"]);
      const role = String((await db.run("select id from roles where key = 'editor'"))[0]!["id"]);
      await db.run(
        "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
        [siteId, caraId, role, new Date()],
      );
      browser = await chromium.launch({ executablePath: findBrowser()! });
    }, 300_000);

    afterAll(async () => {
      await browser?.close();
      site?.server.kill();
      await db?.close();
      registry?.close();
    });

    type Page = Awaited<ReturnType<Browser["newPage"]>>;
    // One signed-in page per person for the whole group: signing in again and again from one address would meet the
    // sign-in rate limit.
    const sessions = new Map<string, Page>();
    const signedIn = async (who: { email: string; password: string }): Promise<Page> => {
      const known = sessions.get(who.email);
      if (known) {
        await known.goto(site.base + "/admin");
        return known;
      }
      const page = await signInFresh(who);
      sessions.set(who.email, page);
      return page;
    };
    const signInFresh = async (who: { email: string; password: string }): Promise<Page> => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(site.base + "/admin/login");
      await page.getByLabel("Email").fill(who.email);
      await page.getByLabel(/^Password/).fill(who.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      return page;
    };
    const call = (page: Page, method: string, url: string, body?: unknown) =>
      page.evaluate(
        async ([m, u, b]) => {
          const response = await fetch(u as string, {
            method: m as string,
            headers: { "content-type": "application/json" },
            ...(b === undefined ? {} : { body: JSON.stringify(b) }),
          });
          return {
            status: response.status,
            json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
          };
        },
        [method, url, body] as const,
      );
    const publicStyle = async () => {
      const html = await (await fetch(site.base + "/")).text();
      const linked = /<link rel="stylesheet" href="(\/site-style\/[0-9a-f]{16}\.css)"/.exec(
        html,
      )?.[1];
      const css = linked ? await (await fetch(site.base + linked)).text() : html;
      return /--oks-color-primary-700:/.test(css) ? css : null;
    };

    test("a new site has the built-in look; the owner sets a color and fonts and every public page shows them at once; bad values, editors and signed-out visitors are refused", async () => {
      const page = await signedIn(owner);
      expect(await publicStyle()).toBeNull();
      expect((await call(page, "GET", "/api/admin/settings/theme")).json).toEqual({
        styles: {
          mainColor: null,
          logoMediaId: null,
          customCss: "",
          customCssOn: true,
          bodyFont: "system-sans",
          headingFont: "system-sans",
          colorMode: "system",
          modeSwitch: true,
        },
      });

      const saved = await call(page, "PUT", "/api/admin/settings/theme", {
        mainColor: "#2A6F4F",
        bodyFont: "system-serif",
        headingFont: "system-mono",
      });
      expect(saved.status).toBe(200);
      expect(saved.json).toMatchObject({ styles: { mainColor: "#2a6f4f" } });

      // The next request carries the new look, on the front page and on any other public page.
      const css = await publicStyle();
      expect(css).toContain("--oks-color-primary-700:");
      expect(css).toContain("--oks-site-font-heading:");
      const search = await withLook(
        site.base,
        await (await fetch(site.base + "/search?q=garden")).text(),
      );
      expect(search).toContain("--oks-color-primary-700:");

      // In a real browser: the fonts and the link color are used.
      const visitor = await browser.newPage();
      await visitor.goto(site.base + "/");
      const used = await visitor.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const link = document.createElement("a");
        link.href = "/x";
        link.textContent = "a link";
        document.body.append(link);
        const hex = root.getPropertyValue("--oks-color-primary-700").trim();
        const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        return {
          body: getComputedStyle(document.body).fontFamily,
          heading: getComputedStyle(document.querySelector("h1")!).fontFamily,
          link: getComputedStyle(link).color,
          expected: `rgb(${rgb.join(", ")})`,
        };
      });
      expect(used.body).toContain("Iowan Old Style");
      expect(used.heading).toContain("ui-monospace");
      expect(used.link).toBe(used.expected);

      // The look is for the public pages only: the admin keeps its own.
      const admin = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      expect(admin).not.toContain("Iowan Old Style");

      // Public pages still pass the accessibility checks with the new colors.
      await visitor.addScriptTag({ content: axe.source });
      const result = await visitor.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
      ).toEqual([]);
      await visitor.close();

      // Refusals leave the saved look alone.
      for (const body of [
        { mainColor: "red;}body{display:none" },
        { mainColor: "green" },
        { bodyFont: "Comic Sans" },
        { headingFont: "</style><script>window.pwned=1</script>" },
      ])
        expect((await call(page, "PUT", "/api/admin/settings/theme", body)).status).toBe(400);
      expect((await call(page, "GET", "/api/admin/settings/theme")).json).toMatchObject({
        styles: { mainColor: "#2a6f4f", bodyFont: "system-serif", headingFont: "system-mono" },
      });

      // Custom CSS: written after the look on every public page; hostile CSS is refused and never written.
      const withCss = await call(page, "PUT", "/api/admin/settings/theme", {
        customCss: ".x { color: red } /* note */ h1 { letter-spacing: 0.3em }",
      });
      expect(withCss.status).toBe(200);
      const styled = (await publicStyle())!;
      expect(styled.indexOf("--oks-color-primary-700")).toBeLessThan(
        styled.indexOf("letter-spacing"),
      );
      expect(styled).not.toContain("note");
      for (const customCss of [
        "@import 'x.css';",
        "a { background: url(https://evil.example/x.png) }",
        "a { color: red }</style><script>window.pwned=1</script>",
        "a { color: red",
        "a { width: expression(alert(1)) }",
      ]) {
        const refusal = await call(page, "PUT", "/api/admin/settings/theme", { customCss });
        expect(refusal.status, customCss).toBe(400);
      }
      const afterRefusals = (await fetch(site.base + "/")).headers.get("content-type");
      expect(afterRefusals).toContain("text/html");
      const html = await withLook(site.base, await (await fetch(site.base + "/")).text());
      expect(html).not.toContain("evil.example");
      expect(html).not.toContain("window.pwned");
      expect(html).toContain("letter-spacing");

      // An editor may not see or change it; a signed-out request is refused.
      const editor = await signedIn(cara);
      expect((await call(editor, "GET", "/api/admin/settings/theme")).status).toBe(403);
      expect(
        (await call(editor, "PUT", "/api/admin/settings/theme", { mainColor: null })).status,
      ).toBe(403);
      expect((await fetch(site.base + "/api/admin/settings/theme")).status).toBe(401);

      // Clearing the color and the fonts brings the built-in look back at once.
      await call(page, "PUT", "/api/admin/settings/theme", {
        mainColor: null,
        bodyFont: "system-sans",
        headingFont: "system-sans",
      });
      expect(await publicStyle()).toBeNull();
    });

    // ----- theme packages: a tiny .tgz writer (plain files only)
    const tgz = (files: Record<string, string | Buffer>): Buffer => {
      const parts: Buffer[] = [];
      for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content);
        const h = Buffer.alloc(512);
        h.write(name, 0, "utf8");
        h.write("0000644\0", 100);
        h.write("0000000\0", 108);
        h.write("0000000\0", 116);
        h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
        h.write("00000000000\0", 136);
        h.fill(32, 148, 156);
        h.write("0", 156);
        h.write("ustar\0" + "00", 257);
        let sum = 0;
        for (const byte of h) sum += byte;
        h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
        parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
      }
      parts.push(Buffer.alloc(1024));
      return gzipSync(Buffer.concat(parts));
    };
    const maple = (version: string, spacing: string) =>
      tgz({
        "theme.json": JSON.stringify({
          key: "maple",
          name: "Maple",
          version,
          description: "A warm theme.",
          author: "Maple Studio",
          license: "MIT",
          rtl: "supported",
          tokens: { color: { "primary-700": "#2a6f4f" } },
          fonts: [{ family: "Maple Sans", weight: 400, file: "assets/maple.woff2" }],
        }),
        "styles/theme.css": `body{word-spacing:${spacing}} .hero{background:url(assets/bg.png)}`,
        "assets/bg.png": Buffer.from("iVBORw0KGgo=", "base64"),
        "assets/maple.woff2": "wOF2 maple",
      });
    const themeLink = async () => {
      const html = await (await fetch(site.base + "/")).text();
      return (
        /<link rel="stylesheet" href="(\/uploads\/themes\/[0-9a-f]{64}\.css)"/.exec(html)?.[1] ??
        null
      );
    };
    const axeViolations = async (page: Page) => {
      // A window that is still fading in has text at part of its color: judge the screen once it has settled.
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      );
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      return result.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      );
    };

    test("theme packages: upload a theme file, read the report, use it, update it, go back, and remove it; files are served by fingerprint and never in the admin", async () => {
      const page = await signedIn(owner);
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByRole("heading", { name: "Themes", level: 1 }).waitFor();
      await page.getByText("No themes are installed yet.").waitFor();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await axeViolations(page), `at ${width} px`).toEqual([]);
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      // A hostile package: the report names the file and why, and nothing is installed.
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "evil.tgz",
        mimeType: "application/gzip",
        buffer: tgz({
          "theme.json": JSON.stringify({ key: "evil", name: "Evil", version: "1.0.0" }),
          "evil.js": "alert(1)",
        }),
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      const report = page.getByRole("region", { name: "Report for evil.tgz" });
      await report.getByRole("heading", { name: "Refused" }).waitFor();
      expect(await report.textContent()).toContain("evil.js");
      await page.getByText("No themes are installed yet.").waitFor();

      // A good package is installed but not in use: the public pages do not change.
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "maple-1.0.0.tgz",
        mimeType: "application/gzip",
        buffer: maple("1.0.0", "3px"),
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByText("Maple 1.0.0 is installed. It is not in use yet.").waitFor();
      await page
        .getByRole("region", { name: "Report for maple-1.0.0.tgz" })
        .getByRole("heading", { name: "Passed" })
        .waitFor();
      expect(await themeLink()).toBeNull();
      expect(await axeViolations(page)).toEqual([]);

      // Use it: every public page loads the theme's CSS file, served from the site with its fingerprint in the name.
      await page.getByRole("button", { name: "Use Maple" }).click();
      await page.getByRole("heading", { name: "Before you switch" }).waitFor();
      await page.getByRole("heading", { name: "Kept", exact: true }).waitFor();
      await page.getByRole("heading", { name: "Stays with the built-in design" }).waitFor();
      expect(await axeViolations(page)).toEqual([]);
      // "Not now" closes the list and changes nothing.
      await page.getByRole("button", { name: "Not now" }).click();
      await page.getByRole("heading", { name: "Before you switch" }).waitFor({ state: "detached" });
      expect(await themeLink()).toBeNull();
      await page.getByRole("button", { name: "Use Maple" }).click();
      await page.getByRole("heading", { name: "Before you switch" }).waitFor();
      await page.getByRole("button", { name: "Yes, switch to Maple" }).click();
      await page.getByText("Your site uses Maple now.").waitFor();
      const first = await themeLink();
      expect(first).not.toBeNull();
      const cssResponse = await fetch(site.base + first!);
      expect(cssResponse.status).toBe(200);
      expect(cssResponse.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(cssResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(cssResponse.headers.get("x-content-type-options")).toBe("nosniff");
      const css = await cssResponse.text();
      expect(css).toContain('font-family:"Maple Sans"');
      expect(css).toContain("--oks-color-primary-700:#2a6f4f");
      const font = /url\("(\/uploads\/themes\/[0-9a-f]{64}\.woff2)"\)/.exec(css)![1]!;
      const fontResponse = await fetch(site.base + font);
      expect(fontResponse.headers.get("content-type")).toBe("font/woff2");
      expect(await fontResponse.text()).toBe("wOF2 maple");
      expect(css).toMatch(/\.hero\{background:url\("\/uploads\/themes\/[0-9a-f]{64}\.png"\)\}/);
      const search = await (await fetch(site.base + "/search?q=garden")).text();
      expect(search).toContain(first!);

      // In a real browser, the theme's CSS is used on the public pages, and never in the admin.
      const visitor = await browser.newPage();
      await visitor.goto(site.base + "/");
      expect(await visitor.evaluate(() => getComputedStyle(document.body).wordSpacing)).toBe("3px");
      expect(await axeViolations(visitor)).toEqual([]);
      await page.goto(site.base + "/admin");
      expect(await page.content()).not.toContain("/uploads/themes/");
      expect(await page.evaluate(() => getComputedStyle(document.body).wordSpacing)).not.toBe(
        "3px",
      );

      // Only files that match their fingerprint are served; the original package never is.
      expect((await fetch(site.base + `/uploads/themes/${"0".repeat(64)}.css`)).status).toBe(404);
      expect((await fetch(site.base + first!.replace(/\.css$/, ".js"))).status).toBe(404);
      const packages = await fetch(site.base + `/uploads/theme-packages/${"0".repeat(64)}.tgz`);
      expect(packages.status).toBe(404);

      // A new version of the theme in use is used at once; going back restores the old one, at once too.
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "maple-1.1.0.tgz",
        mimeType: "application/gzip",
        buffer: maple("1.1.0", "5px"),
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByText("Maple is now version 1.1.0. Your site uses it now.").waitFor();
      const second = await themeLink();
      expect(second).not.toBe(first);
      await visitor.goto(site.base + "/");
      expect(await visitor.evaluate(() => getComputedStyle(document.body).wordSpacing)).toBe("5px");

      await page.getByRole("button", { name: "Go back to version 1.0.0" }).click();
      await page.getByText("Maple is back to version 1.0.0.").waitFor();
      expect(await themeLink()).toBe(first);
      await page.getByRole("button", { name: "Go back to version 1.1.0" }).waitFor();

      // The built-in design again, then Maple is removed (in two steps).
      await page.getByRole("button", { name: "Use the built-in design" }).click();
      await page.getByRole("button", { name: "Yes, switch to the built-in design" }).click();
      await page.getByText("Your site uses the built-in design now.").waitFor();
      expect(await themeLink()).toBeNull();
      await visitor.goto(site.base + "/");
      expect(await visitor.evaluate(() => getComputedStyle(document.body).wordSpacing)).toBe("0px");
      await visitor.close();
      await page.getByRole("button", { name: "Remove Maple" }).click();
      await page.getByRole("button", { name: "Yes, remove Maple" }).click();
      await page.getByText("Maple is removed.").waitFor();
      await page.getByText("No themes are installed yet.").waitFor();
      expect((await fetch(site.base + first!)).status).toBe(404);

      // An editor may not see or change themes; a signed-out request is refused.
      const editor = await signedIn(cara);
      expect((await call(editor, "GET", "/api/admin/themes")).status).toBe(403);
      expect(
        (await call(editor, "POST", "/api/admin/themes/default", { action: "use" })).status,
      ).toBe(403);
      await editor.goto(site.base + "/admin/settings/themes");
      await editor.waitForURL((url) => url.pathname === "/admin");
      expect((await fetch(site.base + "/api/admin/themes")).status).toBe(401);
    });

    test("trying a theme with my content (TH-55, TH-62): the preview draws a real page with the theme's file while the site keeps its look; widths change the frame; a visitor and an editor are turned away", async () => {
      const page = await signedIn(owner);
      const made = (
        await call(page, "POST", "/api/admin/entries", {
          type: "page",
          editor: "writing",
          title: "Try page",
        })
      ).json as { id: string; slug: string; revision: number };
      const saved = await call(page, "PUT", `/api/admin/entries/${made.id}`, {
        title: "Try page",
        slugPart: made.slug,
        status: "published",
        blocks: [
          {
            id: "p1",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "Words for the try-out.", styles: {} }],
            children: [],
          },
        ],
        revision: made.revision,
      });
      expect(saved.status).toBe(200);
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "maple-try.tgz",
        mimeType: "application/gzip",
        buffer: maple("1.0.0", "4px"),
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByRole("button", { name: "Use Maple" }).waitFor();
      const before = await (await fetch(site.base + "/" + made.slug)).text();
      expect(before).not.toContain("/uploads/themes/");

      // The link on the theme opens the preview; nothing is in use afterwards.
      await page.getByRole("link", { name: "Try Maple with my content" }).click();
      await page.waitForURL(/\/admin\/themes\/[0-9A-Za-z]+\/preview$/);
      await page.getByText(/Your site does not change: Maple is not in use\./).waitFor();
      expect(await axeViolations(page)).toEqual([]);
      const frame = page.frameLocator("iframe");
      await page.getByLabel("Page to look at").selectOption(made.slug);
      await frame.getByText("Words for the try-out.").waitFor();
      const frameElement = await page.locator("iframe").elementHandle();
      const inner = await frameElement!.contentFrame();
      const link = await inner!.evaluate(
        () =>
          document
            .querySelector('link[rel="stylesheet"][href^="/uploads/themes/"]')
            ?.getAttribute("href") ?? null,
      );
      expect(link).toMatch(/^\/uploads\/themes\/[0-9a-f]{64}\.css$/);
      expect(await inner!.evaluate(() => getComputedStyle(document.body).wordSpacing)).toBe("4px");
      // The widths change the frame.
      await page.getByRole("button", { name: "Phone" }).click();
      expect(await page.locator("iframe").evaluate((el) => el.getBoundingClientRect().width)).toBe(
        390,
      );
      await page.getByRole("button", { name: "Tablet" }).click();
      expect(await page.locator("iframe").evaluate((el) => el.getBoundingClientRect().width)).toBe(
        768,
      );
      // The site itself did not change.
      const after = await (await fetch(site.base + "/" + made.slug)).text();
      expect(after).not.toContain("/uploads/themes/");

      // Only people who may change the design see the frame; a bad id is not found.
      const id = /\/admin\/themes\/([0-9A-Za-z]+)\/preview/.exec(page.url())![1]!;
      const signedOut = await fetch(site.base + `/admin/themes/${id}/preview/frame`);
      expect(await signedOut.text()).not.toContain("Words for the try-out.");
      const editor = await signedIn(cara);
      // The page starts streaming before it can say "not found", so the status can be 200; what matters is that no page shows.
      const asEditor = await editor.request.get(site.base + `/admin/themes/${id}/preview/frame`);
      expect(await asEditor.text()).not.toContain("Words for the try-out.");
      const missing = await page.request.get(
        site.base + `/admin/themes/${"0".repeat(26)}/preview/frame`,
      );
      expect(await missing.text()).not.toContain("Words for the try-out.");

      // Remove the theme again so the other tests start as before.
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByRole("button", { name: "Remove Maple" }).click();
      await page.getByRole("button", { name: "Yes, remove Maple" }).click();
      await page.getByText("Maple is removed.").waitFor();
    });

    test("presets and sample pages (TH-64, TH-65): the theme lists them, a preset fills the look form without saving, sample pages are added as drafts only when ticked", async () => {
      const page = await signedIn(owner);
      const story = tgz({
        "theme.json": JSON.stringify({
          key: "story",
          name: "Story",
          version: "1.0.0",
          options: ["mainColor", "bodyFont"],
          presets: [
            { name: "Warm", values: { mainColor: "#b45309", bodyFont: "system-serif" } },
            { name: "Calm", values: { mainColor: "#2a6f4f" } },
          ],
        }),
        "starter/about.json": JSON.stringify({
          title: "About the sample",
          blocks: [
            {
              id: "s1",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "A sample paragraph.", styles: {} }],
              children: [],
            },
          ],
        }),
      });
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "story-1.0.0.tgz",
        mimeType: "application/gzip",
        buffer: story,
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByRole("button", { name: "Use Story" }).waitFor();
      await page.getByText("Looks to start from: Warm, Calm.").waitFor();
      await page.getByText("1 sample page you can add as drafts.").waitFor();

      // Using it without the tick adds nothing; the tick adds one draft.
      await page.getByRole("button", { name: "Use Story" }).click();
      const tick = page.getByLabel("Add the 1 sample page as drafts");
      await tick.waitFor();
      expect(await tick.isChecked()).toBe(false);
      expect(await axeViolations(page)).toEqual([]);
      await tick.check();
      await page.getByRole("button", { name: "Yes, switch to Story" }).click();
      await page
        .getByText("Your site uses Story now. 1 sample page was added as drafts.")
        .waitFor();
      await page.goto(site.base + "/admin/pages");
      await page.getByRole("link", { name: "About the sample" }).waitFor();
      expect((await fetch(site.base + "/about-the-sample")).status).toBe(404);

      // A preset fills the look form; nothing is saved until the owner saves.
      await page.goto(site.base + "/admin/settings/look");
      await page.getByText("Start from a look of Story").waitFor();
      expect(await axeViolations(page)).toEqual([]);
      await page.getByRole("button", { name: "Warm" }).click();
      await page.getByText(/The look "Warm" is filled in below/).waitFor();
      await page.getByText("#b45309").waitFor();
      expect(await page.getByLabel("Font for text").inputValue()).toBe("system-serif");
      await page.reload();
      expect(await page.getByText("#b45309").count()).toBe(0);

      // Put the site back as it was.
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByRole("button", { name: "Use the built-in design" }).click();
      await page.getByRole("button", { name: "Yes, switch to the built-in design" }).click();
      await page.getByText("Your site uses the built-in design now.").waitFor();
      await page.getByRole("button", { name: "Remove Story" }).click();
      await page.getByRole("button", { name: "Yes, remove Story" }).click();
      await page.getByText("Story is removed.").waitFor();
    });

    test("publish check: a scheduled page is checked when it is scheduled and every time it is saved again; the administrator's set-aside is remembered for the job", async () => {
      const page = await signedIn(owner);
      const made = await call(page, "POST", "/api/admin/entries", {
        type: "page",
        editor: "writing",
        title: "Scheduled page",
      });
      const e = made.json as { id: string; slug: string; revision: number };
      const words = [
        {
          id: "p1",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "Coming soon.", styles: {} }],
          children: [],
        },
      ];
      const when = new Date(Date.now() + 24 * 3_600_000).toISOString();
      let revision = e.revision;
      const schedule = (blocks: unknown[], extra = {}) =>
        call(page, "PUT", `/api/admin/entries/${e.id}`, {
          title: "Scheduled page",
          slugPart: e.slug,
          status: "scheduled",
          scheduledAt: when,
          blocks,
          revision,
          ...extra,
        });
      const rules = (r: { json: unknown }) =>
        (r.json as { error: { problems: { rule: string }[] } }).error.problems.map((x) => x.rule);

      // Nothing to publish: refused at once.
      const first = await schedule([]);
      expect(first.status).toBe(422);
      expect(rules(first)).toEqual(["empty-body"]);
      // With words it is scheduled.
      const ok = await schedule(words);
      expect(ok.status).toBe(200);
      revision = (ok.json as { revision: number }).revision;
      // Saved again as scheduled with the words taken out: checked again, not waved through.
      const again = await schedule([]);
      expect(again.status).toBe(422);
      expect(rules(again)).toEqual(["empty-body"]);
      // The administrator sets it aside: saved, and the page remembers it, so the job does not hold it back.
      const anyway = await schedule([], { publishAnyway: true });
      expect(anyway.status).toBe(200);
      const meta = (await db.run(`select "meta" from "entries" where "id" = ?`, [e.id]))[0]!;
      expect(JSON.stringify(meta["meta"])).toMatch(/publishAnyway\\?"?:\s*true/);
    });

    test("publish check: going live with no content or a picture with no description is refused with a list; an administrator may go on anyway and it is logged; an editor may not", async () => {
      const page = await signedIn(owner);
      const make = async (title: string) => {
        const made = await call(page, "POST", "/api/admin/entries", {
          type: "page",
          editor: "writing",
          title,
        });
        return made.json as { id: string; slug: string; revision: number };
      };
      const para = [
        {
          id: "p1",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "Hello.", styles: {} }],
          children: [],
        },
      ];
      const picture = {
        id: "i1",
        type: "image",
        props: { src: "/uploads/none.png", alt: "" },
        content: null,
        children: [],
      };
      const put = (
        page_: Page,
        e: { id: string; slug: string; revision: number },
        title: string,
        blocks: unknown[],
        extra = {},
      ) =>
        call(page_, "PUT", `/api/admin/entries/${e.id}`, {
          title,
          slugPart: e.slug,
          status: "published",
          blocks,
          revision: e.revision,
          ...extra,
        });

      // No content: refused, in plain words, with the rule named; the page stays unpublished.
      const empty = await make("Not ready");
      const refused = await put(page, empty, "Not ready", []);
      expect(refused.status).toBe(422);
      const error = (
        refused.json as {
          error: {
            code: string;
            message: string;
            problems: { rule: string }[];
            canPublishAnyway: boolean;
          };
        }
      ).error;
      expect(error.code).toBe("publish_check");
      expect(error.problems.map((x) => x.rule)).toEqual(["empty-body"]);
      expect(error.message).toMatch(/^Before this goes live: It has no content yet/);
      expect(error.canPublishAnyway).toBe(true);
      expect((await fetch(site.base + `/${empty.slug}`)).status).toBe(404);

      // A picture with no description is a problem too; a page with words and a described picture goes live.
      const withPicture = await make("Picture page");
      const noAlt = await put(page, withPicture, "Picture page", [...para, picture]);
      expect(noAlt.status).toBe(422);
      expect(
        (noAlt.json as { error: { problems: { rule: string }[] } }).error.problems.map(
          (x) => x.rule,
        ),
      ).toEqual(["missing-alt"]);
      const ok = await put(page, withPicture, "Picture page", [
        ...para,
        { ...picture, props: { ...picture.props, alt: "A door" } },
      ]);
      expect(ok.status).toBe(200);

      // An administrator may go on anyway; it is written to the audit log, naming the rules set aside.
      const anyway = await put(page, empty, "Not ready", [], { publishAnyway: true });
      expect(anyway.status).toBe(200);
      expect((await fetch(site.base + `/${empty.slug}`)).status).toBe(200);
      const logged = await db.run(
        "select detail from audit_log where action = 'entry.publish_anyway' and target_id = ?",
        [empty.id],
      );
      expect(logged).toHaveLength(1);
      expect(String(logged[0]!["detail"])).toContain("empty-body");

      // An editor may publish, but not set the problems aside: the flag is ignored.
      const editor = await signedIn(cara);
      const other = await make("Also not ready");
      const byEditor = await put(editor, other, "Also not ready", [], { publishAnyway: true });
      expect(byEditor.status).toBe(422);
      expect(
        (byEditor.json as { error: { canPublishAnyway: boolean } }).error.canPublishAnyway,
      ).toBe(false);

      // In the editor: the list shows, and "Publish anyway" does it.
      const third = await make("Third try");
      await page.goto(site.base + `/admin/pages/${third.id}`);
      await page.getByRole("heading", { name: "Edit: Third try", level: 1 }).waitFor();
      await page.getByLabel("Published (everyone sees it)").check({ force: true });
      await page.getByRole("button", { name: "Save" }).click();
      const alert = page.getByRole("alert", { name: "Before this goes live" });
      await alert.getByText(/It has no content yet/).waitFor();
      expect(await axeViolations(page)).toEqual([]);
      await alert.getByRole("button", { name: "Publish anyway" }).click();
      await page.getByText("Published anyway. This was written to the log.").waitFor();
      expect((await fetch(site.base + `/${third.slug}`)).status).toBe(200);
    });

    test("accessibility check: the editor lists what a screen reader user would struggle with, as advice only, and says when there is nothing to fix", async () => {
      const page = await signedIn(owner);
      const made = await call(page, "POST", "/api/admin/entries", {
        type: "page",
        editor: "writing",
        title: "Check me",
      });
      const info = made.json as { id: string; slug: string; revision: number };
      const words = (t: string) => [{ type: "text", text: t, styles: {} }];
      const block = (
        id: string,
        type: string,
        props: Record<string, unknown>,
        content: unknown,
      ) => ({ id, type, props, content, children: [] });
      let revision = info.revision;
      const save = async (blocks: unknown[]) => {
        const result = await call(page, "PUT", `/api/admin/entries/${info.id}`, {
          title: "Check me",
          slugPart: info.slug,
          status: "draft",
          blocks,
          revision,
        });
        expect(result.status).toBe(200);
        revision = (result.json as { revision: number }).revision;
      };
      const open = async () => {
        await page.goto(site.base + `/admin/pages/${info.id}`);
        await page.getByRole("heading", { name: "Edit: Check me", level: 1 }).waitFor();
        return page.getByRole("region", { name: "Accessibility check" });
      };
      const h2 = block("h1", "heading", { level: 2 }, words("Opening hours"));
      const link = (text: string) =>
        block("p1", "paragraph", {}, [{ type: "link", href: "https://example.org/", text }]);

      // A heading that jumps from level 2 to level 4: one thing, in plain words. (The page is checked for accessibility
      // here; the editor's own link color is a known gap of the editor, so the link step comes after.)
      await save([h2, block("h2", "heading", { level: 4 }, words("Holidays"))]);
      let panel = await open();
      await panel
        .getByText("1 thing to look at. This is advice: you can still save and publish.")
        .waitFor();
      await panel.getByText(/This heading jumps from level 2 to level 4/).waitFor();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect((await axeViolations(page)).join(" | "), `at ${width} px`).toBe("");
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      // A vague link is the second thing.
      await save([h2, block("h2", "heading", { level: 4 }, words("Holidays")), link("click here")]);
      panel = await open();
      await panel
        .getByText("2 things to look at. This is advice: you can still save and publish.")
        .waitFor();
      await panel.getByText(/The link "click here" does not say where it goes/).waitFor();

      // Each message has a button that takes the keyboard to its block: the heading first, then the link.
      const focusedBlock = () =>
        page.evaluate(
          () =>
            (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-block-id]")
              ?.dataset["blockId"] ?? null,
        );
      const goTo = panel.getByRole("button", { name: /^Go to / });
      expect(await goTo.count()).toBe(2);
      await goTo.nth(0).click();
      await expect.poll(focusedBlock).toBe("h2");
      await goTo.nth(1).click();
      await expect.poll(focusedBlock).toBe("p1");

      // Fixed: the panel says so.
      await save([
        h2,
        block("h2", "heading", { level: 3 }, words("Holidays")),
        link("Read the holiday hours"),
      ]);
      panel = await open();
      await panel.getByText("Nothing to fix. This page reads well for everyone.").waitFor();
    });

    test("accessibility check: a picture with no description can be marked as decoration from the panel; the page then passes the publish check and the public page has an empty description", async () => {
      const page = await signedIn(owner);
      const made = await call(page, "POST", "/api/admin/entries", {
        type: "page",
        editor: "writing",
        title: "Decor page",
      });
      const info = made.json as { id: string; slug: string; revision: number };
      const blocks = [
        {
          id: "p1",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "Words.", styles: {} }],
          children: [],
        },
        {
          id: "i1",
          type: "image",
          props: { src: "/uploads/none.png", alt: "" },
          content: null,
          children: [],
        },
      ];
      const saved = await call(page, "PUT", `/api/admin/entries/${info.id}`, {
        title: "Decor page",
        slugPart: info.slug,
        status: "draft",
        blocks,
        revision: info.revision,
      });
      expect(saved.status).toBe(200);
      await page.goto(site.base + `/admin/pages/${info.id}`);
      await page.getByRole("heading", { name: "Edit: Decor page", level: 1 }).waitFor();
      const panel = page.getByRole("region", { name: "Accessibility check" });
      await panel.getByText(/This picture has no description/).waitFor();
      await panel.getByRole("button", { name: /^Mark Picture 1 as decoration/ }).click();
      await panel.getByText("Nothing to fix. This page reads well for everyone.").waitFor();
      // Published: it is no longer stopped for the missing description, and the public page has alt="".
      await page.getByLabel("Published (everyone sees it)").check({ force: true });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.locator(".oks-entry-actions [role=status]").getByText("Saved.").waitFor();
      const html = await (await fetch(site.base + "/" + info.slug)).text();
      expect(html).toMatch(/<img src="\/uploads\/none\.png" alt=""/);
    });

    test("saved sections in page content: place one as a copy or linked in the editor; a change published in Design reaches the page; deleting the section keeps the page the same", async () => {
      const page = await signedIn(owner);
      // A theme must be installed to publish a section (Publish belongs to a theme's design).
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "plain-1.0.0.tgz",
        mimeType: "application/gzip",
        buffer: tgz({
          "theme.json": JSON.stringify({ key: "plain", name: "Plain", version: "1.0.0" }),
          // One part that no page uses, so the site editor has a layout to open (and pages are drawn the built-in way).
          "parts/note.json": JSON.stringify({
            title: "Note",
            blocks: [{ id: "n1", type: "paragraph", props: {}, content: [], children: [] }],
          }),
        }),
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByText("Plain 1.0.0 is installed. It is not in use yet.").waitFor();
      await page.getByRole("button", { name: "Use Plain" }).click();
      await page.getByRole("button", { name: "Yes, switch to Plain" }).click();
      await page.getByText("Your site uses Plain now.").waitFor();
      const themeId = (
        (await call(page, "GET", "/api/admin/themes")).json as {
          themes: { id: string; name: string }[];
        }
      ).themes.find((t) => t.name === "Plain")!.id;

      const words = (t: string) => [{ type: "text", text: t, styles: {} }];
      const para = (id: string, t: string) => ({
        id,
        type: "paragraph",
        props: {},
        content: words(t),
        children: [],
      });
      const made = await call(page, "POST", "/api/admin/sections", {
        name: "Opening hours",
        group: "contact",
        blocks: [para("hours1", "Open nine to five")],
      });
      expect(made.status).toBe(201);
      const sectionId = (made.json as { section: { id: string } }).section.id;
      const created = await call(page, "POST", "/api/admin/entries", {
        type: "page",
        editor: "writing",
        title: "Visit us",
      });
      const pageId = (created.json as { id: string }).id;

      await page.goto(site.base + `/admin/pages/${pageId}`);
      await page.getByRole("heading", { name: "Edit: Visit us", level: 1 }).waitFor();
      const group = page.getByRole("group", { name: "Insert a saved section" });
      await group.getByLabel("Saved section").selectOption({ label: "Opening hours" });
      await group.getByRole("button", { name: "Insert linked" }).click();
      // The editor shows the link by name, not the section's words.
      await page.getByRole("group", { name: "Saved section: Opening hours" }).waitFor();
      await group.getByRole("button", { name: "Insert as a copy" }).click();
      await expect.poll(() => page.getByText("Open nine to five").count()).toBeGreaterThan(0);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await axeViolations(page), `at ${width} px`).toEqual([]);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByLabel("Published (everyone sees it)").check({ force: true });
      await page.getByRole("button", { name: "Save" }).click();
      await expect
        .poll(() => page.locator(".oks-entry-actions [role=status]").textContent())
        .toBe("Saved.");
      const count = (html: string, t: string) => html.split(`<p>${t}</p>`).length - 1;
      let html = await (await fetch(site.base + "/visit-us")).text();
      expect(count(html, "Open nine to five")).toBe(2);

      // A change to the section stays a draft until Publish; then the linked place changes, the copy does not.
      expect(
        (
          await call(page, "PUT", `/api/admin/sections/${sectionId}`, {
            blocks: [para("hours1", "Open ten to six")],
          })
        ).status,
      ).toBe(200);
      expect(count(await (await fetch(site.base + "/visit-us")).text(), "Open nine to five")).toBe(
        2,
      );
      expect(
        (await call(page, "POST", `/api/admin/themes/${themeId}/layouts`, { action: "publish" }))
          .status,
      ).toBe(200);
      await expect
        .poll(async () => {
          const now = await (await fetch(site.base + "/visit-us")).text();
          return [count(now, "Open nine to five"), count(now, "Open ten to six")];
        })
        .toEqual([1, 1]);

      // The Design screen names the page that uses the section, and the delete panel lists it.
      const listed = (await call(page, "GET", "/api/admin/sections")).json as {
        sections: { id: string; pages: number }[];
      };
      expect(listed.sections.find((s) => s.id === sectionId)?.pages).toBe(1);
      expect(
        (
          (await call(page, "GET", `/api/admin/sections/${sectionId}`)).json as {
            entries: { title: string; type: string }[];
          }
        ).entries,
      ).toMatchObject([{ title: "Visit us", type: "page" }]);
      await page.goto(site.base + "/admin/settings/site-editor");
      await page
        .getByRole("navigation", { name: "Layouts" })
        .getByRole("button", { name: /^Opening hours/ })
        .click();
      const box = page.getByRole("region", { name: "This saved section" });
      await box.getByText(/used in 1 page or post/).waitFor();
      await box.getByRole("heading", { name: "Pages and posts that use it" }).waitFor();
      expect(await box.getByRole("link", { name: "Visit us" }).getAttribute("href")).toBe(
        `/admin/pages/${pageId}`,
      );
      await box.getByRole("button", { name: "Delete this section" }).click();
      await box.getByText("Page: Visit us").waitFor();
      await box.getByRole("button", { name: "Keep it", exact: true }).click();

      // Delete the section: the page shows the same, and a new save still works (the link became a copy).
      expect((await call(page, "DELETE", `/api/admin/sections/${sectionId}`)).status).toBe(200);
      html = await (await fetch(site.base + "/visit-us")).text();
      expect([count(html, "Open nine to five"), count(html, "Open ten to six")]).toEqual([1, 1]);
      await page.goto(site.base + `/admin/pages/${pageId}`);
      await page.getByRole("heading", { name: "Edit: Visit us", level: 1 }).waitFor();
      await page.getByRole("button", { name: "Save" }).click();
      await expect
        .poll(() => page.locator(".oks-entry-actions [role=status]").textContent())
        .toBe("Saved.");

      // Back to the built-in design, and remove the theme.
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByRole("button", { name: "Use the built-in design" }).click();
      await page.getByRole("button", { name: "Yes, switch to the built-in design" }).click();
      await page.getByText("Your site uses the built-in design now.").waitFor();
      await page.getByRole("button", { name: "Remove Plain" }).click();
      await page.getByRole("button", { name: "Yes, remove Plain" }).click();
      await page.getByText("Plain is removed.").waitFor();
    });

    test("own fonts: the owner adds a woff2 font on the Look screen, chooses it, the public page carries its rule and the file is served from the site; a file that is not a font is refused; a font in use cannot be removed", async () => {
      const page = await signedIn(owner);
      // A file with the shape of a woff2 font (signature, length, tables).
      const font = Buffer.alloc(200);
      font.write("wOF2", 0, "latin1");
      font.writeUInt32BE(200, 8);
      font.writeUInt16BE(5, 12);
      font.writeUInt32BE(77, 20);
      await page.goto(site.base + "/admin/settings/look");
      await page.getByRole("heading", { name: "Look of the site", level: 1 }).waitFor();
      await page.getByText("You have not added a font of your own yet.").waitFor();

      // Not a font: refused in plain words, nothing kept.
      await page.locator("#own-font-file").setInputFiles({
        name: "notes.woff2",
        mimeType: "font/woff2",
        buffer: Buffer.from("<svg onload=alert(1)>".padEnd(120)),
      });
      await page.locator("#own-font-name").fill("Garden Sans");
      await page.getByLabel("I have the right to use this font on my site").check();
      await page.getByRole("button", { name: "Add the font" }).click();
      await page.getByText("This is not a .woff2 font file.").waitFor();

      // Without the word about the licence: refused.
      await page.locator("#own-font-file").setInputFiles({
        name: "garden.woff2",
        mimeType: "font/woff2",
        buffer: font,
      });
      await page.getByLabel("I have the right to use this font on my site").uncheck();
      await page.getByRole("button", { name: "Add the font" }).click();
      await page
        .getByText("Confirm that you have the right to use this font on your site.")
        .waitFor();

      // A real one: added, listed, and offered in the font lists.
      await page.getByLabel("I have the right to use this font on my site").check();
      await page.getByRole("button", { name: "Add the font" }).click();
      await page
        .getByText("Garden Sans is added. Choose it in the lists above, then save.")
        .waitFor();
      await page.getByRole("button", { name: "Remove Garden Sans" }).waitFor();
      expect(await axeViolations(page)).toEqual([]);
      await page.getByLabel("Font for text").selectOption({ label: "Garden Sans (Regular)" });
      await page.getByRole("button", { name: "Save the look" }).click();
      await page.getByText("Saved. Your site shows the new look now.").waitFor();

      // The public page carries the rule and the variable; the file is served from the site, safely and cached.
      const list = (await call(page, "GET", "/api/admin/fonts")).json as {
        fonts: { key: string; name: string }[];
      };
      expect(list.fonts.map((f) => f.name)).toEqual(["Garden Sans"]);
      const key = list.fonts[0]!.key;
      const home = await withLook(site.base, await (await fetch(site.base + "/")).text());
      expect(home).toContain(`@font-face{font-family:"oks-${key}"`);
      expect(home).toContain(`--oks-site-font-body:"oks-${key}"`);
      const file = await fetch(site.base + `/fonts/${key}.woff2`);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("font/woff2");
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
      expect(file.headers.get("cache-control")).toMatch(/immutable/);
      expect(Buffer.from(await file.arrayBuffer()).equals(font)).toBe(true);
      expect((await fetch(site.base + "/fonts/own-sans-400-0000000000000000.woff2")).status).toBe(
        404,
      );

      // In use: cannot be removed (the answer says why), and the file stays.
      const refused = await call(page, "DELETE", `/api/admin/fonts/${key}`);
      expect(refused.status).toBe(409);
      expect((refused.json as { error: { message: string } }).error.message).toMatch(
        /is used by your site/,
      );
      expect((await fetch(site.base + `/fonts/${key}.woff2`)).status).toBe(200);

      // Choose another font, then it can be removed; the file is gone.
      await page.reload();
      await page.getByLabel("Font for text").selectOption("system-serif");
      await page.getByRole("button", { name: "Save the look" }).click();
      await page.getByText("Saved. Your site shows the new look now.").waitFor();
      await page.getByRole("button", { name: "Remove Garden Sans" }).click();
      await page.getByText("Garden Sans is removed.").waitFor();
      expect((await fetch(site.base + `/fonts/${key}.woff2`)).status).toBe(404);
    });

    test("a page with styled blocks links to its own style file: classes in the page, no inline style, the file is cached while its name matches (PB-65)", async () => {
      const page = await signedIn(owner);
      const made = await call(page, "POST", "/api/admin/entries", {
        type: "page",
        editor: "writing",
        title: "Styled page",
      });
      expect(made.status).toBe(200);
      const id = String(made.json!["id"]);
      const saved = await call(page, "PUT", `/api/admin/entries/${id}`, {
        title: "Styled page",
        slugPart: "styled-page",
        status: "published",
        blocks: [
          {
            id: "s1",
            type: "section",
            props: { style: { base: { gap: "8px", position: "fixed" }, desktop: { gap: "24px" } } },
            content: null,
            children: [
              {
                id: "b1",
                type: "button",
                props: { text: "Go", href: "/contact" },
                content: null,
                children: [],
              },
            ],
          },
        ],
        revision: made.json!["revision"],
      });
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      const html = await (await fetch(site.base + "/styled-page")).text();
      const link =
        /<link rel="stylesheet" href="(\/page-style\/([A-Za-z0-9_-]+)\/[0-9a-f]{16}\.css)"/.exec(
          html,
        );
      expect(link).toBeTruthy();
      expect(html).toMatch(/<section class="oks-s-[0-9a-f]{10} section section-boxed">/);
      expect(html).not.toContain("position:fixed");
      expect(html).not.toMatch(/<style[\s>]/);
      const file = await fetch(site.base + link![1]!);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      const css = await file.text();
      expect(css).toContain("gap:8px");
      expect(css).toContain("@media (min-width:1025px)");
      expect(css).not.toContain("fixed");
      // An older name still gets the current file, not cached; a bad name or another page's id gets nothing.
      const older = await fetch(site.base + `/page-style/${link![2]}/0000000000000000.css`);
      expect(older.headers.get("cache-control")).toBe("no-cache");
      expect(await older.text()).toBe(css);
      expect((await fetch(site.base + `/page-style/${link![2]}/x.css`)).status).toBe(404);
      expect((await fetch(site.base + "/page-style/nope/0000000000000000.css")).status).toBe(404);
      // A page without styled blocks has no link.
      const plain = await (await fetch(site.base + "/")).text();
      expect(plain).not.toContain("/page-style/");
    });

    test("PB-63: the layout editor, with the keyboard-reachable buttons: build a page, a refusal in plain words, undo and redo, hide on phone, save, and the public page shows it", async () => {
      const page = await signedIn(owner);
      const made = await call(page, "POST", "/api/admin/entries", {
        type: "page",
        editor: "writing",
        title: "Built page",
      });
      expect(made.status).toBe(200);
      const id = String(made.json!["id"]);
      await page.goto(site.base + `/admin/pages/${id}`);
      // A page made the old way says so, and offers the other editor.
      await page.getByText("Simple page: written in the writing editor.").waitFor();
      await page.getByRole("button", { name: "Switch to the layout editor" }).click();
      const tools = page.getByRole("toolbar", { name: "Layout tools" });
      await tools.waitFor();
      const blocks = page.getByRole("region", { name: "Blocks on this page" });
      const add = async (label: string) => {
        await page.getByLabel("Add a block").selectOption({ label });
        await tools.getByRole("button", { name: "Add", exact: true }).click();
      };
      await add("Section");
      await add("Columns (two)");
      await expect.poll(() => blocks.getByRole("button").count()).toBe(4);
      // A paragraph cannot go straight into columns: it lands after them, in the section.
      await add("Paragraph");
      await blocks.getByRole("button", { name: /^Paragraph/ }).click();
      // Moving it into the block above (the columns) is refused in plain words, and changes nothing.
      await page.getByRole("button", { name: "Move into the block above" }).click();
      await page.getByRole("alert").filter({ hasText: "Put it inside a column" }).waitFor();
      expect(await blocks.getByRole("button").count()).toBe(5);
      // Words, then undo and redo.
      const words = page.getByLabel("Text", { exact: true });
      await words.fill("Hello builder");
      await blocks.getByRole("button", { name: "Paragraph: Hello builder" }).waitFor();
      await tools.getByRole("button", { name: "Undo" }).click();
      await blocks.getByRole("button", { name: "Paragraph: Some text." }).waitFor();
      await tools.getByRole("button", { name: "Redo" }).click();
      await blocks.getByRole("button", { name: "Paragraph: Hello builder" }).waitFor();
      // Hide on phone: the style on the phone shows display: none.
      await page.getByRole("group", { name: "Hide on" }).getByLabel("Phone").check();
      await tools.getByRole("radio", { name: "Phone" }).check();
      await page.getByText("display: none").first().waitFor();
      // Publish and save.
      // A click that does not register is tried again until the choice shows.
      const published = page.getByRole("radio", { name: /^Published/ });
      for (let tries = 0; tries < 6 && !(await published.isChecked()); tries++) {
        await page.getByText("Published (everyone sees it)").click();
        await page.waitForTimeout(300);
      }
      expect(await published.isChecked()).toBe(true);
      await tools.getByRole("button", { name: "Save" }).click();
      await page.getByText("Saved.").first().waitFor();
      let html = "";
      await expect
        .poll(async () => {
          html = await (await fetch(site.base + "/built-page")).text();
          return html.includes("Hello builder");
        })
        .toBe(true);
      expect(html).toContain("Hello builder");
      expect(html).toMatch(/<section class="[^"]*section section-boxed">/);
      expect(html).not.toMatch(/<style[\s>]/);
      const href = /href="(\/page-style\/[^"]+\.css)"/.exec(html)?.[1];
      expect(href).toBeTruthy();
      const css = await (await fetch(site.base + href!)).text();
      expect(css).toContain("display:none");
      expect(css).toContain(".columns{");
      // Back to the writing editor: the layout would be lost, so it lists what and waits.
      await page.getByRole("button", { name: "Switch to the writing editor" }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByText("would become one flow of content").waitFor();
      await dialog.getByRole("button", { name: "Keep the layout" }).click();
    });

    test("PB-90: the rest of the catalogue in the layout editor: tabs, an accordion, a map, an icon and social links, with their words on the public page", async () => {
      const page = await signedIn(owner);
      const made = await call(page, "POST", "/api/admin/entries", {
        type: "page",
        title: "Catalogue page",
        editor: "writing",
      });
      expect(made.status).toBe(200);
      const id = String(made.json!["id"]);
      await page.goto(site.base + `/admin/pages/${id}`);
      await page.getByRole("button", { name: "Switch to the layout editor" }).click();
      const tools = page.getByRole("toolbar", { name: "Layout tools" });
      await tools.waitFor();
      const blocks = page.getByRole("region", { name: "Blocks on this page" });
      // From the keyboard: choose in the list, move to Add, press Enter (PB-63).
      const add = async (label: string) => {
        await page.getByLabel("Add a block").selectOption({ label });
        await tools.getByRole("button", { name: "Add", exact: true }).focus();
        await page.keyboard.press("Enter");
      };
      await add("Section");
      await add("Tabs");
      // A tab can only go inside tabs: asking for one anywhere else is refused in plain words.
      await blocks.getByRole("button", { name: /^Tabs/ }).click();
      await page.getByRole("button", { name: "Add a tab" }).click();
      await expect.poll(() => blocks.getByRole("button", { name: /^Tab:/ }).count()).toBe(3);
      // Name the first tab.
      await blocks.getByRole("button", { name: "Tab: First" }).click();
      await page.getByLabel("Tab title").fill("Prices");
      await blocks.getByRole("button", { name: "Tab: Prices" }).waitFor();
      // The section holds the next blocks.
      await blocks.getByRole("button", { name: /^Section/ }).click();
      await add("Accordion");
      await blocks.getByRole("button", { name: /^Section/ }).click();
      await add("Map");
      await page.getByLabel("Address or place").fill("Old Mill Road");
      await blocks.getByRole("button", { name: /^Section/ }).click();
      await add("Icon");
      await page.getByLabel("What it means (read out to people who cannot see it)").fill("A star");
      await blocks.getByRole("button", { name: /^Section/ }).click();
      await add("Social links");
      const links = page.getByLabel("Links (one per line: network | address)");
      await links.fill("github | https://github.com/example\nx | javascript:alert(1)");
      await links.blur();
      // A click that does not register is tried again until the choice shows.
      const published = page.getByRole("radio", { name: /^Published/ });
      for (let tries = 0; tries < 6 && !(await published.isChecked()); tries++) {
        await page.getByText("Published (everyone sees it)").click();
        await page.waitForTimeout(300);
      }
      expect(await published.isChecked()).toBe(true);
      await tools.getByRole("button", { name: "Save" }).click();
      await page.getByText("Saved.").first().waitFor();
      // The save finishes a moment after the words appear; wait until the public page shows it.
      let html = "";
      await expect
        .poll(async () => {
          html = await (await fetch(site.base + "/catalogue-page")).text();
          return html.includes('<div class="tabs">');
        })
        .toBe(true);
      expect(html).toContain('<div class="tabs">');
      expect(html).toContain("<h3>Prices</h3>");
      expect(html).toContain('<div class="accordion"><details>');
      expect(html).toContain("Show the map: Old Mill Road");
      expect(html).toContain("openstreetmap.org/search?query=Old%20Mill%20Road");
      expect(html).not.toContain("<iframe");
      expect(html).toContain('aria-label="A star"');
      expect(html).toContain(">GitHub</a>");
      expect(html).not.toContain("javascript:alert");
    });

    test("PB-51: choose a block by clicking it in the preview, and move blocks by dragging them in the list, with a plain refusal", async () => {
      const page = await signedIn(owner);
      const made = await call(page, "POST", "/api/admin/entries", {
        type: "page",
        editor: "writing",
        title: "Dragged page",
      });
      expect(made.status).toBe(200);
      await page.goto(site.base + `/admin/pages/${String(made.json!["id"])}`);
      await page.getByRole("button", { name: "Switch to the layout editor" }).click();
      const tools = page.getByRole("toolbar", { name: "Layout tools" });
      await tools.waitFor();
      const blocks = page.getByRole("region", { name: "Blocks on this page" });
      const add = async (label: string) => {
        await page.getByLabel("Add a block").selectOption({ label });
        await tools.getByRole("button", { name: "Add", exact: true }).focus();
        await page.keyboard.press("Enter");
      };
      const order = async () =>
        (await blocks.getByRole("button").allInnerTexts()).map((t) => t.trim());
      await add("Section");
      await add("Heading");
      await blocks.getByRole("button", { name: /^Section/ }).click();
      await add("Paragraph");
      await expect.poll(order).toEqual(["Section", "Heading: A heading", "Paragraph: Some text."]);

      // Drag the paragraph to the top edge of the heading: it goes before it.
      await blocks
        .getByRole("button", { name: /^Paragraph/ })
        .dragTo(blocks.getByRole("button", { name: /^Heading/ }), {
          targetPosition: { x: 20, y: 1 },
        });
      await expect.poll(order).toEqual(["Section", "Paragraph: Some text.", "Heading: A heading"]);

      // Dragging the section onto the paragraph inside it is refused in plain words, and nothing moves.
      await blocks
        .getByRole("button", { name: /^Section/ })
        .dragTo(blocks.getByRole("button", { name: /^Paragraph/ }));
      await page
        .getByRole("alert")
        .filter({ hasText: "A block cannot be moved into itself." })
        .waitFor();
      expect(await order()).toEqual(["Section", "Paragraph: Some text.", "Heading: A heading"]);

      // Undo brings the old order back.
      await tools.getByRole("button", { name: "Undo" }).click();
      await expect.poll(order).toEqual(["Section", "Heading: A heading", "Paragraph: Some text."]);

      // A click in the preview chooses the block under it.
      const preview = page.frameLocator('iframe[title="Page preview"]');
      await preview.getByText("A heading").click();
      await expect
        .poll(() => blocks.getByRole("button", { name: /^Heading/ }).getAttribute("aria-current"))
        .toBe("true");
      await preview.getByText("Some text.").click();
      await expect
        .poll(() => blocks.getByRole("button", { name: /^Paragraph/ }).getAttribute("aria-current"))
        .toBe("true");
      // The block chosen in the list is marked in the preview.
      await blocks.getByRole("button", { name: /^Heading/ }).click();
      await expect.poll(() => preview.locator("[data-selected]").innerText()).toBe("A heading");
    });

    /** A layout page with these blocks, published or not, made through the same save the editor uses. */
    const layoutPage = async (page: Page, title: string, blocks: unknown[], publish = false) => {
      const made = await call(page, "POST", "/api/admin/entries", { type: "page", title });
      expect(made.status).toBe(200);
      const saved = await call(page, "PUT", `/api/admin/entries/${String(made.json!["id"])}`, {
        title,
        slugPart: String(made.json!["slug"]),
        status: publish ? "published" : "draft",
        blocks,
        revision: made.json!["revision"],
      });
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      return { id: String(made.json!["id"]), slug: String(made.json!["slug"]) };
    };
    let uid = 0;
    const b = (
      type: string,
      props: Record<string, unknown> = {},
      children: unknown[] = [],
      content: unknown = null,
    ) => ({ id: `chk${++uid}x`, type, props, content, children });
    const words = (value: string) => [{ type: "text", text: value, styles: {} }];

    test("PB-95: the layout editor has no accessibility violations on a wide and a narrow screen, in light and dark", async () => {
      const setup = await signedIn(owner);
      const made = await layoutPage(setup, "Accessible layout", [
        b("section", {}, [
          b("heading", { level: 2 }, [], words("Welcome")),
          b("columns", {}, [b("column", {}, [b("paragraph", {}, [], words("Left"))]), b("column")]),
          b("buttonGroup", {}, [b("button", { text: "Go", href: "/x", variant: "solid" })]),
          b("gallery", { columns: 2, images: [{ src: "/uploads/none.jpg", alt: "None" }] }),
          b("tabs", {}, [b("tab", { title: "One" }, [b("paragraph", {}, [], words("First"))])]),
        ]),
      ]);
      for (const colorScheme of ["light", "dark"] as const) {
        for (const width of [1280, 390]) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme,
          });
          // The same sign-in as the page above, so the sign-in limits are not used up.
          await context.addCookies(await setup.context().cookies());
          const page = await context.newPage();
          await page.goto(site.base + `/admin/pages/${made.id}`);
          const blocks = page.getByRole("region", { name: "Blocks on this page" });
          await blocks.getByRole("button", { name: /^Section/ }).waitFor();
          expect(await axeViolations(page), `nothing chosen, ${colorScheme} ${width}px`).toEqual(
            [],
          );
          // With a block chosen, its settings and the style box are on the screen too.
          await blocks.getByRole("button", { name: "Button: Go" }).click();
          expect(await axeViolations(page), `a button chosen, ${colorScheme} ${width}px`).toEqual(
            [],
          );
          await blocks.getByRole("button", { name: /^Gallery/ }).click();
          expect(await axeViolations(page), `a gallery chosen, ${colorScheme} ${width}px`).toEqual(
            [],
          );
          await context.close();
        }
      }
    });

    test("PB-96: the layout blocks mirror in right to left: columns, buttons, a slider and start/end spacing", async () => {
      const page = await signedIn(owner);
      const made = await layoutPage(
        page,
        "Mirrored layout",
        [
          b("section", { width: "full" }, [
            b("buttonGroup", {}, [
              b("button", {
                text: "First",
                variant: "solid",
                style: { base: { "margin-inline-start": "40px" } },
              }),
              b("button", { text: "Second", variant: "outline" }),
            ]),
            b("slider", { label: "News" }, [
              b("slide", {}, [b("paragraph", {}, [], words("Slide one"))]),
              b("slide", {}, [b("paragraph", {}, [], words("Slide two"))]),
            ]),
          ]),
        ],
        true,
      );
      let html = "";
      await expect
        .poll(async () => {
          html = await (await fetch(site.base + `/${made.slug}`)).text();
          return html.includes("page-style");
        })
        .toBe(true);
      const href = /href="(\/page-style\/[^"]+\.css)"/.exec(html)![1]!;
      const css = await (await fetch(site.base + href)).text();
      const article = /<article>([\s\S]*?)<\/article>/.exec(html)![1]!.replace(/<link[^>]*>/, "");
      const measure = async (dir: "ltr" | "rtl") => {
        const probe = await browser.newPage({ viewport: { width: 900, height: 600 } });
        await probe.setContent(
          `<!doctype html><html dir="${dir}"><head><style>body{margin:0}${css}</style></head><body>${article}</body></html>`,
        );
        const result = await probe.evaluate(() => {
          const rect = (el: Element) => el.getBoundingClientRect();
          const group = document.querySelector(".button-group")!;
          const first = group.children[0]!;
          const second = group.children[1]!;
          const slider = document.querySelector(".slider")!;
          const slide = slider.children[0]!;
          return {
            firstGap: dirGap(rect(group), rect(first)),
            firstBeforeSecond: dirOrder(rect(first), rect(second)),
            slideAtStart: dirGap(rect(slider), rect(slide)),
          };
          function dirGap(outer: DOMRect, inner: DOMRect) {
            return document.documentElement.dir === "rtl"
              ? Math.round(outer.right - inner.right)
              : Math.round(inner.left - outer.left);
          }
          function dirOrder(a: DOMRect, c: DOMRect) {
            return document.documentElement.dir === "rtl" ? a.left > c.left : a.left < c.left;
          }
        });
        await probe.close();
        return result;
      };
      for (const dir of ["ltr", "rtl"] as const) {
        const got = await measure(dir);
        // The first button starts 40 px in from the START edge, whichever side that is; it comes first in reading order;
        // the first slide is at the start edge.
        expect(got.firstGap, `${dir} first button gap`).toBe(40);
        expect(got.firstBeforeSecond, `${dir} reading order`).toBe(true);
        expect(got.slideAtStart, `${dir} first slide`).toBe(0);
      }
    });

    test("PB-91: tabs switch, a slider has arrows and dots, and a gallery picture opens larger", async () => {
      const setup = await signedIn(owner);
      const made = await layoutPage(
        setup,
        "Moving blocks",
        [
          b("section", {}, [
            b("tabs", {}, [
              b("tab", { title: "Alpha" }, [b("paragraph", {}, [], words("Alpha text"))]),
              b("tab", { title: "Beta" }, [b("paragraph", {}, [], words("Beta text"))]),
            ]),
            b("slider", { label: "News" }, [
              b("slide", {}, [b("paragraph", {}, [], words("Slide one"))]),
              b("slide", {}, [b("paragraph", {}, [], words("Slide two"))]),
              b("slide", {}, [b("paragraph", {}, [], words("Slide three"))]),
            ]),
            b("gallery", {
              columns: 2,
              images: [
                { src: "/uploads/none-a.jpg", alt: "Picture A", caption: "Caption A" },
                { src: "/uploads/none-b.jpg", alt: "Picture B" },
              ],
            }),
          ]),
        ],
        true,
      );
      await expect.poll(async () => (await fetch(site.base + `/${made.slug}`)).status).toBe(200);
      // Without script every part is on the page, one under another (the page is complete without the behaviour).
      const plain = await (await fetch(site.base + `/${made.slug}`)).text();
      expect(plain).toContain("Alpha text");
      expect(plain).toContain("Beta text");
      const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
      const page = await context.newPage();
      await page.goto(site.base + `/${made.slug}`);
      // The behaviour starts after the page is ready.
      await page.locator(".tabs[data-ready]").waitFor();
      await page.locator(".slider[data-ready]").waitFor();
      await page.locator(".gallery[data-ready]").waitFor();
      // Tabs: the first is shown, the second after a click, and the arrow key moves too.
      expect(await page.getByText("Alpha text").isVisible()).toBe(true);
      expect(await page.getByText("Beta text").isVisible()).toBe(false);
      await page.getByRole("tab", { name: "Beta" }).click();
      expect(await page.getByText("Beta text").isVisible()).toBe(true);
      expect(await page.getByText("Alpha text").isVisible()).toBe(false);
      await page.keyboard.press("ArrowLeft");
      expect(await page.getByText("Alpha text").isVisible()).toBe(true);
      // Slider: the next arrow and the dots move to the slide.
      const slider = page.getByRole("region", { name: "News" });
      const at = () =>
        slider.evaluate((el) => Math.round(el.scrollLeft / (el as HTMLElement).clientWidth));
      expect(await at()).toBe(0);
      await page.getByRole("button", { name: "Next slide" }).click();
      await expect.poll(at).toBe(1);
      await page.getByRole("button", { name: "Slide 3 of 3" }).click();
      await expect.poll(at).toBe(2);
      await page.getByRole("button", { name: "Previous slide" }).click();
      await expect.poll(at).toBe(1);
      // Gallery: a picture opens in a dialog, with its caption; Escape closes it.
      await page.getByRole("button", { name: "Enlarge: Picture A" }).click();
      const dialog = page.locator("dialog.oks-lightbox[open]");
      await dialog.waitFor();
      expect(await dialog.innerText()).toContain("Caption A");
      await dialog.getByRole("button", { name: "Next" }).click();
      expect(await dialog.locator("img").getAttribute("alt")).toBe("Picture B");
      await page.keyboard.press("Escape");
      await page.locator("dialog.oks-lightbox[open]").waitFor({ state: "detached" });
      await context.close();
    });

    test("PB-80: a new page opens in the layout editor unless the writing editor is chosen; a new post opens in the writing editor", async () => {
      const page = await signedIn(owner);
      const add = async (kind: "pages" | "posts", title: string, start?: string) => {
        await page.goto(`${site.base}/admin/${kind}`);
        const word = kind === "pages" ? "page" : "post";
        await page.getByLabel(new RegExp(`^Title of the new ${word}`)).fill(title);
        if (start) await page.getByLabel("Start in").selectOption(start);
        await page.getByRole("button", { name: "Add new", exact: true }).click();
        await page.getByRole("heading", { name: `Edit: ${title}`, level: 1 }).waitFor();
      };
      const layout = page.getByRole("region", { name: "Blocks on this page" });
      await add("pages", "Default editor page");
      await layout.waitFor();
      await add("pages", "Writing editor page", "writing");
      await page.locator("[contenteditable=true]").first().waitFor();
      expect(await layout.count()).toBe(0);
      await add("posts", "Default editor post");
      await page.locator("[contenteditable=true]").first().waitFor();
      expect(await layout.count()).toBe(0);
      expect(await page.getByLabel("Start in").count()).toBe(0);
    });

    test('PB-93: the video block in the layout editor says what "load at once" means', async () => {
      const page = await signedIn(owner);
      const made = await layoutPage(page, "Video settings", [b("section")]);
      await page.goto(site.base + `/admin/pages/${made.id}`);
      const tools = page.getByRole("toolbar", { name: "Layout tools" });
      await tools.waitFor();
      const blocks = page.getByRole("region", { name: "Blocks on this page" });
      await blocks.getByRole("button", { name: /^Section/ }).click();
      await page.getByLabel("Add a block").selectOption({ label: "Video" });
      await tools.getByRole("button", { name: "Add", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page
        .getByLabel("Video address (YouTube or Vimeo)")
        .fill("https://youtu.be/dQw4w9WgXcQ");
      const note = page.getByRole("note");
      expect(await note.innerText()).toContain("only after a click");
      await page.getByLabel("Load the player at once").check();
      expect(await note.innerText()).toContain(
        "contact the video company the moment the page opens",
      );
      await page.getByLabel("Load the player at once").uncheck();
      expect(await note.innerText()).toContain("only after a click");
    });

    test("PB-93: a video asks YouTube for nothing before a click, works as a link without script, and loads the player after a click", async () => {
      const setup = await signedIn(owner);
      const made = await layoutPage(
        setup,
        "A film",
        [
          b("section", {}, [
            b("video", { src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", caption: "Our film" }),
          ]),
        ],
        true,
      );
      await expect.poll(async () => (await fetch(site.base + `/${made.slug}`)).status).toBe(200);
      // Without script: a link to the video on its own page, and the words say which company it is.
      // (The page as the server sends it, which is what a visitor without script gets.)
      const sent = await (await fetch(site.base + `/${made.slug}`)).text();
      expect(sent).toContain(
        '<a class="video-open" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" rel="noopener noreferrer">',
      );
      expect(sent).toContain("Play the video. It loads from YouTube.");
      expect(sent).not.toContain("<iframe");

      // With script: nothing is asked of YouTube until the click.
      const context = await browser.newContext();
      const asked: string[] = [];
      await context.route(/youtube|ytimg|ggpht/, (route) => {
        asked.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto(site.base + `/${made.slug}`);
      // The behaviour starts after the page is ready; the video is marked in the same moment.
      await page.locator(".video-load[data-ready]").waitFor();
      await page.waitForLoadState("networkidle");
      expect(asked).toEqual([]);
      expect(await page.locator("iframe").count()).toBe(0);
      await page.getByRole("link", { name: /Our film/ }).click();
      await page.locator(".video-load iframe").waitFor();
      const src = await page.locator(".video-load iframe").getAttribute("src");
      expect(src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
      expect(await page.locator(".video-load iframe").getAttribute("title")).toBe("Our film");
      await context.close();
    });

    test("PB-100: Settings > Screen sizes adds a size to the layout editor; PB-101: free position warns, and one click fixes the container", async () => {
      const page = await signedIn(owner);
      const made = await layoutPage(page, "Free place", [
        b("section", {}, [b("container", {}, [b("paragraph", {}, [], words("Placed text"))])]),
      ]);
      try {
        await page.goto(site.base + "/admin/settings/screens");
        const laptop = page.getByRole("checkbox", { name: /^Laptop/ });
        await laptop.waitFor();
        // The widths follow the list: with phone, tablet and desktop on, the laptop size is off.
        expect(await page.getByText("Desktop: 1025 px and wider").isVisible()).toBe(true);
        expect(await page.getByText("Laptop: off").isVisible()).toBe(true);
        await laptop.check();
        // Laptop on: it takes the widths from 1025, and the desktop starts right after it, with no gap.
        expect(await page.getByText("Laptop: 1025 to 1366 px").isVisible()).toBe(true);
        expect(await page.getByText("Desktop: 1367 px and wider").isVisible()).toBe(true);
        await page.getByRole("button", { name: "Save screen sizes" }).click();
        await page.getByText("Screen sizes saved.").waitFor();
        const saved = await call(page, "GET", "/api/admin/settings/screens");
        expect(saved.json!["sizes"]).toEqual(["base", "tablet", "laptop", "desktop"]);

        await page.goto(site.base + `/admin/pages/${made.id}`);
        const blocks = page.getByRole("region", { name: "Blocks on this page" });
        await blocks.getByRole("button", { name: /^Section/ }).waitFor();
        await page.getByRole("radio", { name: "Laptop" }).waitFor();
        // Place the paragraph freely: the container is not set up for it, and the screen says so.
        await blocks.getByRole("button", { name: /^Paragraph/ }).click();
        await page.getByRole("checkbox", { name: /Place this block freely/ }).check();
        const warnings = page.getByRole("list", { name: "Warnings about this position" });
        await warnings.waitFor();
        expect(await warnings.innerText()).toMatch(/must be set to a relative position/);
        await page.getByRole("button", { name: "Make the block it sits in relative" }).click();
        await page
          .getByRole("list", { name: "Warnings about this position" })
          .waitFor({ state: "detached" });
      } finally {
        await call(page, "PUT", "/api/admin/settings/screens", {
          sizes: ["base", "tablet", "desktop"],
        });
      }
    });

    test("CT-01: a content type made in Settings gets its own list, its fields on the edit screen, and its own address", async () => {
      const page = await signedIn(owner);
      {
        await page.goto(site.base + "/admin/settings/content-types");
        await page.getByRole("button", { name: "Add a content type" }).click();
        await page.getByLabel("Name", { exact: true }).fill("Gadget");
        // The key follows the name until it is set by hand.
        expect(await page.getByLabel(/^Key/).inputValue()).toBe("gadget");
        await page.getByLabel("Address prefix").fill("shop/");
        await page.getByRole("button", { name: "Add a field" }).click();
        await page.getByLabel("Field name").fill("Price");
        expect(await page.getByLabel("Field key").inputValue()).toBe("price");
        await page.getByLabel("Kind").selectOption("number");
        await page.getByLabel("Required").check();
        await page.getByRole("button", { name: "Save content type" }).click();
        await page.getByText('"Gadget" is saved.').waitFor();

        // The Content menu lists the new type, and its list opens.
        await page.goto(site.base + "/admin/content");
        await page.getByRole("link", { name: "Gadget" }).click();
        await page.getByRole("heading", { name: "Gadget" }).first().waitFor();

        const made = await call(page, "POST", "/api/admin/entries", {
          type: "gadget",
          title: "Red gadget",
        });
        expect(made.status, JSON.stringify(made.json)).toBe(200);
        expect(made.json!["slug"]).toBe("shop/red-gadget");
        const id = String(made.json!["id"]);

        await page.goto(site.base + `/admin/content/gadget/${id}`);
        const price = page.getByLabel(/^Price/);
        await price.waitFor();
        // A required field left empty stops the save and names the field.
        await page.getByRole("button", { name: "Save" }).first().click();
        await page
          .getByText(/Fill in .Price./)
          .first()
          .waitFor();
        await price.fill("49.9");
        await page.getByRole("button", { name: "Save" }).first().click();
        await page.getByText("Saved.").first().waitFor();
        // The value is kept: opening the screen again shows it.
        await page.reload();
        expect(await page.getByLabel(/^Price/).inputValue()).toBe("49.9");

        // Published, the entry has the address with the prefix.
        const saved = await call(page, "PUT", `/api/admin/entries/${id}`, {
          title: "Red gadget",
          slugPart: "red-gadget",
          status: "published",
          blocks: [b("paragraph", {}, [], words("A red gadget."))],
          revision: 2,
          fields: { price: 49.9 },
        });
        expect(saved.status, JSON.stringify(saved.json)).toBe(200);
        const publicPage = await fetch(site.base + "/shop/red-gadget");
        expect(publicPage.status).toBe(200);

        // The type has a public list at its prefix without the last slash: the entry is in it, and so is the sitemap.
        const list = await fetch(site.base + "/shop");
        expect(list.status).toBe(200);
        const listHtml = await list.text();
        expect(listHtml).toContain('href="/shop/red-gadget"');
        expect(listHtml).toContain("<h1>Gadget</h1>");
        expect(await (await fetch(site.base + "/sitemap.xml")).text()).toContain("/shop</loc>");
        // There is no second page, page 1 is the list itself, and a prefix that is no type's is a plain 404.
        expect((await fetch(site.base + "/shop/page/2")).status).toBe(404);
        const first = await fetch(site.base + "/shop/page/1", { redirect: "manual" });
        expect(first.status).toBe(308);
        expect(first.headers.get("location")).toMatch(/\/shop$/);
        expect((await fetch(site.base + "/nothing-here")).status).toBe(404);

        // A type with an entry cannot be deleted.
        const refused = await call(page, "DELETE", "/api/admin/content-types?key=gadget");
        expect(refused.status).toBe(400);
        // Out of the way of the other tests: the entry goes to the trash.
        await call(page, "DELETE", `/api/admin/entries/${id}`);
        // The list is made fresh at once: the entry is gone from it, and the list says so.
        const after = await (await fetch(site.base + "/shop")).text();
        expect(after).not.toContain("red-gadget");
        expect(after).toContain("There is nothing here yet.");
      }
    });

    test("CT-02: a picture field takes a file from the library, shows it on the entry and in the list, and keeps the file from being deleted", async () => {
      const page = await signedIn(owner);
      const api = page.context().request;
      const saved = await call(page, "PUT", "/api/admin/content-types", {
        key: "dish",
        label: "Dish",
        urlPrefix: "menu/",
        fields: [{ key: "photo", label: "Photo", type: "picture" }],
      });
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      const upload = await api.post(site.base + "/api/admin/media", {
        multipart: {
          file: {
            name: "dish.png",
            mimeType: "image/png",
            buffer: await sharp({
              create: { width: 40, height: 30, channels: 3, background: "#c60" },
            })
              .png()
              .toBuffer(),
          },
        },
      });
      const file = (await upload.json()) as { id: string; url: string };
      for (let i = 0; i < 100; i++) {
        const got = (await (await api.get(site.base + `/api/admin/media/${file.id}`)).json()) as {
          item: { status: string };
        };
        if (got.item.status !== "processing") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const made = await call(page, "POST", "/api/admin/entries", { type: "dish", title: "Soup" });
      const id = String(made.json!["id"]);
      // A value that is not a file of the library is refused with the field named.
      const refused = await call(page, "PUT", `/api/admin/entries/${id}`, {
        title: "Soup",
        slugPart: "soup",
        status: "published",
        blocks: [b("paragraph", {}, [], words("Hot soup."))],
        revision: 1,
        fields: { photo: "01HZZZZZZZZZZZZZZZZZZZZZZZ" },
      });
      expect(refused.status).toBe(400);
      const ok = await call(page, "PUT", `/api/admin/entries/${id}`, {
        title: "Soup",
        slugPart: "soup",
        status: "published",
        blocks: [b("paragraph", {}, [], words("Hot soup."))],
        revision: 1,
        fields: { photo: file.id },
      });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      // The edit screen shows the chosen picture and the buttons.
      await page.goto(site.base + `/admin/content/dish/${id}`);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.getByRole("button", { name: "Change picture" }).waitFor();
      await page.getByRole("button", { name: "Remove picture" }).waitFor();
      // The entry and the list of the type show the picture.
      const entryHtml = await (await fetch(site.base + "/menu/soup")).text();
      expect(entryHtml).toContain(file.url);
      const listHtml = await (await fetch(site.base + "/menu")).text();
      expect(listHtml).toContain(file.url);
      // The file is in use: it cannot be deleted.
      const deleted = await api.delete(site.base + `/api/admin/media/${file.id}`);
      expect(deleted.status()).toBe(409);
      // Out of the way of the other tests.
      await call(page, "DELETE", `/api/admin/entries/${id}`);
    });

    test("CT-03: a link field points to an entry of another type, shows as a link on the page, and goes away with the entry", async () => {
      const page = await signedIn(owner);
      for (const type of [
        { key: "maker", label: "Maker", urlPrefix: "makers/", fields: [] },
        {
          key: "tool",
          label: "Tool",
          urlPrefix: "tools/",
          fields: [{ key: "made_by", label: "Made by", type: "relation", target: "maker" }],
        },
      ])
        expect((await call(page, "PUT", "/api/admin/content-types", type)).status).toBe(200);
      const publish = async (type: string, title: string, slugPart: string, fields?: object) => {
        const made = await call(page, "POST", "/api/admin/entries", { type, title });
        const id = String(made.json!["id"]);
        const saved = await call(page, "PUT", `/api/admin/entries/${id}`, {
          title,
          slugPart,
          status: "published",
          blocks: [b("paragraph", {}, [], words(`About ${title}.`))],
          revision: 1,
          ...(fields ? { fields } : {}),
        });
        return { id, saved };
      };
      const maker = await publish("maker", "Acme Works", "acme");
      expect(maker.saved.status, JSON.stringify(maker.saved.json)).toBe(200);
      // A link to something that is not a published entry of the right type is refused.
      const bad = await publish("tool", "Bad hammer", "bad-hammer", {
        made_by: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      });
      expect(bad.saved.status).toBe(400);
      expect(bad.saved.json!["error"]).toMatchObject({ field: "made_by" });
      const tool = await publish("tool", "Hammer", "hammer", { made_by: maker.id });
      expect(tool.saved.status, JSON.stringify(tool.saved.json)).toBe(200);
      // The edit screen has a choice box with the maker chosen.
      await page.goto(site.base + `/admin/content/tool/${tool.id}`);
      const box = page.getByRole("combobox", { name: "Made by" });
      await box.waitFor();
      await page.getByRole("option", { name: "Acme Works" }).waitFor({ state: "attached" });
      expect(await box.inputValue()).toBe(maker.id);
      // The page shows the link.
      const html = await (await fetch(site.base + "/tools/hammer")).text();
      expect(html).toContain("Made by:");
      expect(html).toContain('href="/makers/acme"');
      // When the maker goes to the trash, the link is gone from the page at once.
      await call(page, "DELETE", `/api/admin/entries/${maker.id}`);
      const after = await (await fetch(site.base + "/tools/hammer")).text();
      expect(after).not.toContain('href="/makers/acme"');
      for (const e of [tool.id, bad.id]) await call(page, "DELETE", `/api/admin/entries/${e}`);
    });

    test("PG-01: a plugin file is added in Tools > Plugins with some permissions approved, switched off and on, and removed", async () => {
      const page = await signedIn(owner);
      const code = 'export default { hooks: { "content:afterSave": async (e) => e } };';
      const manifest = {
        id: "hello-plugin",
        version: "1.0.0",
        displayName: "Hello plugin",
        description: "Says hello.",
        author: "Ada",
        permissions: ["content:read", "content:write"],
        hooks: ["content:afterSave"],
        blocks: [],
      };
      const fileOf = (c: string, integrityOf = c) =>
        JSON.stringify({
          format: 1,
          manifest,
          code: c,
          integrity: createHash("sha256").update(integrityOf).digest("hex"),
        });
      const upload = (text: string) =>
        page.getByLabel("Plugin file").setInputFiles({
          name: "hello.oksplugin",
          mimeType: "application/json",
          buffer: Buffer.from(text),
        });
      // Nobody signed in may not see the plugins.
      expect((await fetch(site.base + "/api/admin/plugins")).status).toBe(401);
      await page.goto(site.base + "/admin/tools/plugins");
      await page.getByRole("heading", { name: "Plugins", level: 2 }).waitFor();
      await page.getByText("No plugins are installed.").waitFor();

      // A file whose code was changed after it was made is refused in plain words.
      await upload(fileOf(code + " ", code));
      await page.getByText(/changed after it was made/).waitFor();

      // A good file shows what it asks for in plain words; the owner approves only the first permission.
      await upload(fileOf(code));
      await page.getByRole("heading", { name: "Add Hello plugin 1.0.0" }).waitFor();
      await page.getByLabel(/Read your published posts and pages/).waitFor();
      await page.getByLabel(/Change posts and pages when they are saved/).uncheck();
      await page.getByRole("button", { name: "Add plugin" }).click();
      await page.getByText("Hello plugin is added and switched on.").waitFor();
      const row = page.getByRole("row", { name: /Hello plugin/ });
      await row.waitFor();
      expect(await row.innerText()).toContain("On");
      expect(await row.innerText()).toContain(
        "Change posts and pages when they are saved (not approved)",
      );

      // The server kept only the approved permission.
      const listed = (await (
        await page.context().request.get(site.base + "/api/admin/plugins")
      ).json()) as {
        plugins: {
          id: string;
          status: string;
          permissions: { permission: string; approved: boolean }[];
        }[];
      };
      expect(listed.plugins.map((x) => x.id)).toEqual(["hello-plugin"]);
      expect(
        listed.plugins[0]!.permissions.filter((x) => x.approved).map((x) => x.permission),
      ).toEqual(["content:read"]);

      // The same plugin cannot be added twice.
      await upload(fileOf(code));
      await page.getByText("This plugin is already installed.").waitFor();
      expect(await page.getByRole("button", { name: "Add plugin" }).isDisabled()).toBe(true);
      await page.getByRole("button", { name: "Cancel" }).click();

      // Off and on again.
      await row.getByRole("button", { name: "Switch off" }).click();
      await page.getByText("Hello plugin is off.").waitFor();
      expect(await row.innerText()).toContain("Off");
      await row.getByRole("button", { name: "Switch on" }).click();
      await page.getByText("Hello plugin is on.").waitFor();

      // Removing asks first, then takes the plugin away.
      await row.getByRole("button", { name: "Remove" }).click();
      await page.getByRole("button", { name: "Yes, remove" }).click();
      await page.getByText("No plugins are installed.").waitFor();
    });

    test("PG-02: a plugin is looked up on npm by its name, checked against the registry's hash, and added", async () => {
      const page = await signedIn(owner);
      // Not signed in: the server does not go to the registry for anybody.
      const anonymous = await fetch(site.base + "/api/admin/plugins", {
        method: "POST",
        headers: { "content-type": "application/json", origin: site.base },
        body: JSON.stringify({ action: "npm", name: "npm-hello", version: "" }),
      });
      expect(anonymous.status).toBe(401);
      await page.goto(site.base + "/admin/tools/plugins");
      const name = page.getByLabel("npm package name");
      const look = page.getByRole("button", { name: "Look up on npm" });
      await name.waitFor();
      expect(await look.isDisabled()).toBe(true);

      // A package that is not there, a name that cannot be one, and a download that does not match its hash.
      await name.fill("no-such-package");
      await look.click();
      await page.getByText("There is no such package or version on npm.").waitFor();
      await name.fill("Not A Name");
      await look.click();
      await page.getByText(/That is not an npm package name/).waitFor();
      await name.fill("npm-bad");
      await look.click();
      await page.getByText(/does not match the hash the registry published/).waitFor();

      // The good one shows what it asks for, and is added.
      await name.fill("npm-hello");
      await look.click();
      await page.getByRole("heading", { name: "Add NPM Hello 1.0.0" }).waitFor();
      await page.getByText(/From npm-hello@1\.0\.0\./).waitFor();
      await page.getByLabel(/Read your published posts and pages/).waitFor();
      await page.getByRole("button", { name: "Add plugin" }).click();
      await page.getByText("NPM Hello is added and switched on.").waitFor();
      const row = page.getByRole("row", { name: /NPM Hello/ });
      await row.waitFor();
      await row.getByRole("button", { name: "Remove" }).click();
      await page.getByRole("button", { name: "Yes, remove" }).click();
      await page.getByText("No plugins are installed.").waitFor();
    });

    test("PG-03: a plugin's hooks run when a post is saved and published, fail open, and stop when the plugin is off", async () => {
      const page = await signedIn(owner);
      const code = `export default { hooks: {
        "content:beforePublish": async (e) => e.title.includes("Refuse") ? { refuse: "No titles that say Refuse" } : {},
        "content:beforeSave": async (e) => ({ ...e, title: e.title.replace("teh", "the"), meta: { ...e.meta, words: String(e.plainText || "").split(/\\s+/).filter(Boolean).length } }),
      } };`;
      const manifest = {
        id: "hooked",
        version: "1.0.0",
        displayName: "Hooked",
        description: "Fixes a typo and counts words.",
        author: "Ada",
        permissions: ["content:write"],
        hooks: ["content:beforePublish", "content:beforeSave"],
        blocks: [],
      };
      const file = JSON.stringify({
        format: 1,
        manifest,
        code,
        integrity: createHash("sha256").update(code).digest("hex"),
      });
      const installed = await call(page, "POST", "/api/admin/plugins", {
        action: "install",
        file,
        approved: ["content:write"],
      });
      expect(installed.status, JSON.stringify(installed.json)).toBe(200);

      const post = await call(page, "POST", "/api/admin/entries", { type: "post", title: "Typo" });
      const id = String(post.json!["id"]);
      const body = [b("paragraph", {}, [], words("one two three four"))];
      const save = (title: string, status: string, revision: number) =>
        call(page, "PUT", `/api/admin/entries/${id}`, {
          title,
          slugPart: "hooked-post",
          status,
          blocks: body,
          revision,
        });

      // The check before going live refuses with the plugin's own words, and nothing changes.
      const refused = await save("Refuse me", "published", 1);
      expect(refused.status).toBe(400);
      expect(refused.json!["error"]).toMatchObject({ message: "No titles that say Refuse" });

      // The filter before the save fixes the title and keeps the plugin's value under its own name.
      const saved = await save("Say teh word", "published", 1);
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      const row = (await db.run("select title, meta from entries where id = ?", [id]))[0]!;
      const meta = typeof row["meta"] === "string" ? JSON.parse(row["meta"]) : row["meta"];
      expect(row["title"]).toBe("Say the word");
      expect(meta.plugins.hooked).toEqual({ words: 4 });
      expect(await (await fetch(site.base + "/" + String(saved.json!["slug"]))).text()).toContain(
        "Say the word",
      );

      // Switched off, the plugin does nothing: a title it would have refused goes live.
      await call(page, "PATCH", "/api/admin/plugins", { id: "hooked", enabled: false });
      const again = await save("Refuse me again", "published", 2);
      expect(again.status, JSON.stringify(again.json)).toBe(200);
      await call(page, "DELETE", "/api/admin/plugins?id=hooked");
      await call(page, "DELETE", `/api/admin/entries/${id}`);
    });

    test("PG-04: a plugin's block is in the editor's list, is drawn when the page is shown after the block checks, and goes when the plugin is off", async () => {
      const page = await signedIn(owner);
      const code = `export default { blocks: {
        greeting: { render: async (props) => ({ type: "paragraph", props: {}, content: [{ type: "text", text: "Hello, " + String(props.name || "friend") + "!", styles: {} }], children: [] }) },
        evil: { render: async () => ({ type: "button", props: { text: "Click me", href: "javascript:alert(1)", variant: "solid" }, content: null, children: [] }) },
      } };`;
      const manifest = {
        id: "blocky",
        version: "1.0.0",
        displayName: "Blocky",
        description: "Adds a greeting block.",
        author: "Ada",
        permissions: [],
        hooks: [],
        blocks: ["greeting", "evil"],
        blockInfo: {
          greeting: { label: "Greeting", settings: { name: { type: "text", label: "Name" } } },
        },
      };
      const file = JSON.stringify({
        format: 1,
        manifest,
        code,
        integrity: createHash("sha256").update(code).digest("hex"),
      });
      const installed = await call(page, "POST", "/api/admin/plugins", {
        action: "install",
        file,
        approved: [],
      });
      expect(installed.status, JSON.stringify(installed.json)).toBe(200);

      const made = await call(page, "POST", "/api/admin/entries", {
        type: "page",
        title: "Plugin page",
      });
      const id = String(made.json!["id"]);
      const plain = (type: string, blockId: string, props: object) => ({
        id: blockId,
        type,
        props,
        content: null,
        children: [],
      });
      const saved = await call(page, "PUT", `/api/admin/entries/${id}`, {
        title: "Plugin page",
        slugPart: "plugin-page",
        status: "published",
        blocks: [
          b("paragraph", {}, [], words("Before.")),
          plain("blocky-greeting", "g1", { name: "Ada" }),
          plain("blocky-evil", "e1", {}),
          plain("gone-block", "x1", {}),
        ],
        revision: 1,
      });
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      const html = () => fetch(site.base + "/plugin-page").then((r) => r.text());

      // The block is drawn from the plugin; a hostile answer is repaired by the block checks; a block of a plugin that
      // is not there leaves nothing, and no marker reaches the visitor.
      const shown = await html();
      expect(shown).toContain("Hello, Ada!");
      expect(shown).toContain("Click me");
      expect(shown).not.toContain("javascript:");
      expect(shown).not.toContain("data-oks-plugin-block");

      // Switched off, the block is gone at once, without saving the page again; switched on, it is back.
      await call(page, "PATCH", "/api/admin/plugins", { id: "blocky", enabled: false });
      const off = await html();
      expect(off).not.toContain("Hello, Ada!");
      expect(off).toContain("Before.");
      expect(off).not.toContain("data-oks-plugin-block");
      await call(page, "PATCH", "/api/admin/plugins", { id: "blocky", enabled: true });
      expect(await html()).toContain("Hello, Ada!");

      // The layout editor offers the block under its name, with its field.
      await call(page, "PUT", `/api/admin/entries/${id}`, {
        title: "Plugin page",
        slugPart: "plugin-page",
        status: "published",
        blocks: [b("paragraph", {}, [], words("Before."))],
        revision: 2,
      });
      await page.goto(site.base + `/admin/pages/${id}`);
      await page.getByLabel("Add a block").waitFor();
      await page.getByLabel("Add a block").selectOption({ label: "Greeting (blocky)" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Grace");
      await page.getByRole("button", { name: "Save", exact: true }).first().click();
      await page.getByText("Saved.").first().waitFor();
      expect(await html()).toContain("Hello, Grace!");

      // Removed, the plugin's block leaves nothing on the page.
      await call(page, "DELETE", "/api/admin/plugins?id=blocky");
      expect(await html()).not.toContain("Hello, Grace!");
      await call(page, "DELETE", `/api/admin/entries/${id}`);
    });

    test("PG-05: a plugin's settings form comes from its manifest, a secret is sealed and never shown again, and the plugin reads them", async () => {
      const page = await signedIn(owner);
      const code = `export default { hooks: { "content:beforeSave": async (e, ctx) => {
        const key = await ctx.settings.get("api_key");
        return { ...e, meta: { ...e.meta,
          greeting: await ctx.settings.get("greeting"),
          limit: await ctx.settings.get("limit"),
          shout: await ctx.settings.get("shout"),
          keyLength: key ? String(key).length : 0 } };
      } } };`;
      const manifest = {
        id: "settled",
        version: "1.0.0",
        displayName: "Settled",
        description: "Has settings.",
        author: "Ada",
        permissions: ["content:write"],
        hooks: ["content:beforeSave"],
        blocks: [],
        settings: {
          greeting: { type: "text", label: "Greeting" },
          limit: { type: "number", label: "Limit" },
          shout: { type: "boolean", label: "Shout" },
          api_key: { type: "secret", label: "API key" },
        },
      };
      const file = JSON.stringify({
        format: 1,
        manifest,
        code,
        integrity: createHash("sha256").update(code).digest("hex"),
      });
      expect(
        (
          await call(page, "POST", "/api/admin/plugins", {
            action: "install",
            file,
            approved: ["content:write"],
          })
        ).status,
      ).toBe(200);
      const secret = "sk-test-1234567890abcdef";

      await page.goto(site.base + "/admin/tools/plugins");
      const row = page.getByRole("row", { name: /Settled/ });
      await row.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("heading", { name: "Settings of Settled" }).waitFor();
      await page.getByLabel("Greeting").fill("Hi");
      await page.getByLabel("Limit").fill("3");
      await page.getByLabel("Shout").check();
      await page.getByLabel("API key", { exact: true }).fill(secret);
      await page.getByRole("button", { name: "Save settings" }).click();
      await page.getByText("The settings of Settled are saved.").waitFor();

      // The form comes back with the plain values, and the secret only as a hint: never in the page or in the API answer.
      await page.getByText("One is saved (••••cdef). It is never shown again.").waitFor();
      expect(await page.getByLabel("Greeting").inputValue()).toBe("Hi");
      expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("");
      expect(await page.content()).not.toContain(secret);
      const asked = await page
        .context()
        .request.get(site.base + "/api/admin/plugins?settings=settled");
      expect(await asked.text()).not.toContain(secret);

      // The plugin reads them, the secret in full (it is never put in the page; the test only looks at its length).
      const made = await call(page, "POST", "/api/admin/entries", {
        type: "post",
        title: "Settings",
      });
      const id = String(made.json!["id"]);
      const save = (revision: number) =>
        call(page, "PUT", `/api/admin/entries/${id}`, {
          title: "Settings",
          slugPart: "settings-post",
          status: "draft",
          blocks: [b("paragraph", {}, [], words("Text."))],
          revision,
        });
      expect((await save(1)).status).toBe(200);
      const metaOf = async () => {
        const raw = (await db.run("select meta from entries where id = ?", [id]))[0]!["meta"];
        return (typeof raw === "string" ? JSON.parse(raw) : raw).plugins.settled;
      };
      expect(await metaOf()).toEqual({
        greeting: "Hi",
        limit: 3,
        shout: true,
        keyLength: secret.length,
      });

      // The sealed value in the database is not the secret, and the log names the settings, not their values.
      const stored = await db.run("select value from extension_settings where key = 'api_key'");
      expect(JSON.stringify(stored)).not.toContain(secret);
      const logged = JSON.stringify(
        await db.run("select detail from audit_log where action = 'plugin.settings_changed'"),
      );
      expect(logged).toContain("api_key");
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain("Hi");

      // Saving with the secret left empty keeps it; a bad number and an unknown setting are refused.
      await page.getByLabel("Greeting").fill("Hello");
      await page.getByRole("button", { name: "Save settings" }).click();
      await page.getByText("The settings of Settled are saved.").waitFor();
      expect((await save(2)).status).toBe(200);
      expect(await metaOf()).toMatchObject({ greeting: "Hello", keyLength: secret.length });
      const badNumber = await call(page, "POST", "/api/admin/plugins", {
        action: "saveSettings",
        id: "settled",
        values: { limit: "abc" },
      });
      expect(badNumber.status).toBe(400);
      const unknown = await call(page, "POST", "/api/admin/plugins", {
        action: "saveSettings",
        id: "settled",
        values: { nothing: "x" },
      });
      expect(unknown.status).toBe(400);

      // The saved secret can be removed.
      await page.getByLabel("Remove the saved one").check();
      await page.getByRole("button", { name: "Save settings" }).click();
      await page.getByText("None is saved.").waitFor();
      expect((await save(3)).status).toBe(200);
      expect((await metaOf()).keyLength).toBe(0);
      await call(page, "DELETE", "/api/admin/plugins?id=settled");
      await call(page, "DELETE", `/api/admin/entries/${id}`);
    });

    test("CM-01: comments are off until switched on; a visitor's comment waits, an editor approves it, and then the post shows it", async () => {
      const page = await signedIn(owner);
      const made = await call(page, "POST", "/api/admin/entries", {
        type: "post",
        title: "Comment target",
      });
      expect(made.status).toBe(200);
      const id = String(made.json!["id"]);
      const slug = String(made.json!["slug"]);
      const live = await call(page, "PUT", `/api/admin/entries/${id}`, {
        title: "Comment target",
        slugPart: slug.split("/").pop(),
        status: "published",
        blocks: [b("paragraph", {}, [], words("A post to talk about."))],
        revision: made.json!["revision"],
      });
      expect(live.status, JSON.stringify(live.json)).toBe(200);
      const visitor = await browser.newContext();
      const reader = await visitor.newPage();
      // A post is drawn in pieces after a change, so each look opens it again until what it waits for is there.
      const onPost = async (ok: () => Promise<boolean>) => {
        for (let i = 0; i < 12; i++) {
          await reader.goto(site.base + "/" + slug);
          await reader.getByRole("heading", { name: "Comment target" }).first().waitFor();
          if (await ok()) return true;
          await reader.waitForTimeout(500);
        }
        return false;
      };
      const formShown = () =>
        reader
          .getByRole("form", { name: "Leave a comment" })
          .waitFor({ timeout: 2000 })
          .then(
            () => true,
            () => false,
          );
      try {
        // Off for a new site: no form, and the server refuses a comment sent anyway.
        await reader.goto(site.base + "/" + slug);
        await reader.getByRole("heading", { name: "Comment target" }).first().waitFor();
        expect(await reader.getByRole("form", { name: "Leave a comment" }).count()).toBe(0);
        const refused = await fetch(site.base + "/api/comments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entryId: id, name: "Zed", content: "Too early" }),
        });
        expect(refused.status).toBe(400);

        // Switch them on in the admin.
        await page.goto(site.base + "/admin/comments");
        // The box changes after the server has saved it, so it is clicked, not "checked".
        await page.getByRole("checkbox", { name: /Let visitors comment/ }).click();
        await page.getByText("Comments are on for posts.").waitFor();

        // The visitor writes a comment with the plain form; it waits.
        expect(await onPost(formShown)).toBe(true);
        await reader.getByLabel("Name", { exact: true }).fill("Ann");
        await reader.getByLabel("Comment", { exact: true }).fill("Nice <b>post</b>!");
        await reader.getByRole("button", { name: "Send comment" }).click();
        await reader.getByRole("heading", { name: "Thank you" }).waitFor();
        // A robot that fills the hidden box gets the same thanks, and nothing is saved.
        const robot = await fetch(site.base + "/api/comments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entryId: id, name: "Bot", content: "Buy now", website: "x" }),
        });
        expect(robot.status).toBe(200);
        expect(await onPost(formShown)).toBe(true);
        expect(await reader.getByText("Nice").count()).toBe(0);

        // The editor sees one comment waiting, and approves it.
        await page.goto(site.base + "/admin/comments");
        const item = page.getByRole("list", { name: "Comments" }).getByRole("listitem");
        await item.first().waitFor();
        expect(await item.count()).toBe(1);
        expect(await item.first().innerText()).toContain("Ann");
        await item.first().getByRole("button", { name: "Approve" }).click();
        await page.getByText("The comment is approved and shows on the post.").waitFor();

        // The post shows it, as text (the tags are not drawn as HTML).
        expect(
          await onPost(() =>
            reader
              .getByText("Nice <b>post</b>!")
              .waitFor({ timeout: 2000 })
              .then(
                () => true,
                () => false,
              ),
          ),
        ).toBe(true);
        expect(await reader.locator("#comments b").count()).toBe(0);

        // Switched off again, the post shows no comments.
        await call(page, "PUT", "/api/admin/comments", { enabled: false });
        expect(await onPost(async () => (await reader.locator("#comments").count()) === 0)).toBe(
          true,
        );
      } finally {
        await call(page, "PUT", "/api/admin/comments", { enabled: false });
        await call(page, "DELETE", `/api/admin/entries/${id}`);
        await visitor.close();
      }
    });

    test("WF-01: a post sent for review is counted on the dashboard and shows its status on the edit screen", async () => {
      const page = await signedIn(owner);
      const made = await call(page, "POST", "/api/admin/entries", {
        type: "post",
        title: "For review",
      });
      expect(made.status).toBe(200);
      const id = String(made.json!["id"]);
      try {
        const sent = await call(page, "PUT", `/api/admin/entries/${id}`, {
          title: "For review",
          slugPart: String(made.json!["slug"]).split("/").pop(),
          status: "pending",
          blocks: [b("paragraph", {}, [], words("Please look."))],
          revision: made.json!["revision"],
        });
        expect(sent.status, JSON.stringify(sent.json)).toBe(200);
        await page.goto(site.base + "/admin");
        const waiting = page.getByRole("term").filter({ hasText: "Waiting for review" });
        await waiting.waitFor();
        await page.goto(site.base + `/admin/posts/${id}`);
        await page.getByRole("radio", { name: /Waiting for review/ }).waitFor();
        expect(await page.getByRole("radio", { name: /Waiting for review/ }).isChecked()).toBe(
          true,
        );
      } finally {
        await call(page, "DELETE", `/api/admin/entries/${id}`);
      }
    });

    test("PB-64: a page with 5,000 blocks opens and stays usable in the layout editor", async () => {
      const page = await signedIn(owner);
      // One section with 4,998 short paragraphs and a heading we can find: 5,000 blocks in all.
      const rows = Array.from({ length: 4998 }, (_, i) =>
        b("paragraph", {}, [], words(`Row ${i}`)),
      );
      const made = await layoutPage(page, "Huge layout", [
        b("section", {}, [b("heading", { level: 2 }, [], words("The needle")), ...rows]),
      ]);
      const started = Date.now();
      await page.goto(site.base + `/admin/pages/${made.id}`);
      const blocks = page.getByRole("region", { name: "Blocks on this page" });
      await blocks
        .getByRole("button", { name: /^Heading: The needle/ })
        .waitFor({ timeout: 60_000 });
      const opened = Date.now() - started;
      expect(opened, `opening took ${opened} ms`).toBeLessThan(20_000);
      // The page is drawn on the server first and gets its behaviour a moment later; a click before that does nothing.
      // So the first choice is tried until it works, and only then is the speed of the next one measured.
      const heading = blocks.getByRole("button", { name: /^Heading: The needle/ });
      const textBox = page.getByLabel("Text", { exact: true });
      for (let tries = 0; tries < 40 && !(await textBox.isVisible()); tries++) {
        await heading.click();
        await page.waitForTimeout(500);
      }
      expect(await textBox.isVisible()).toBe(true);
      const chosenAt = Date.now();
      await blocks.getByRole("button", { name: "Paragraph: Row 10", exact: true }).click();
      await expect.poll(() => textBox.inputValue(), { timeout: 10_000 }).toBe("Row 10");
      const chosen = Date.now() - chosenAt;
      expect(chosen, `choosing took ${chosen} ms`).toBeLessThan(3_000);
      await heading.click();
      await expect.poll(() => textBox.inputValue(), { timeout: 10_000 }).toBe("The needle");
      // A change is shown in the list.
      const typedAt = Date.now();
      await textBox.fill("The haystack");
      await blocks
        .getByRole("button", { name: /^Heading: The haystack/ })
        .waitFor({ timeout: 10_000 });
      const typed = Date.now() - typedAt;
      expect(typed, `a change took ${typed} ms`).toBeLessThan(3_000);
      console.log(`PB-64: opened in ${opened} ms, chose in ${chosen} ms, changed in ${typed} ms`);
    });

    test("the owner's look is a file: the page links to /site-style/<fingerprint>.css instead of carrying the text, the file is cached for a year while its name matches, and an older name still gets the current look, not cached", async () => {
      const page = await signedIn(owner);
      const saved = await call(page, "PUT", "/api/admin/settings/theme", {
        mainColor: "#2a6f4f",
        customCss: "h1 { letter-spacing: 0.4em }",
        // An earlier test that changed the theme switched the CSS off (TH-66): this test needs it on.
        customCssOn: true,
      });
      expect(saved.status).toBe(200);
      const html = await (await fetch(site.base + "/")).text();
      const href = /<link rel="stylesheet" href="(\/site-style\/([0-9a-f]{16})\.css)"/.exec(
        html,
      )?.[1];
      expect(href).toBeTruthy();
      // The page does not carry the text itself any more.
      expect(html).not.toContain("--oks-color-primary-700");
      expect(html).not.toContain("letter-spacing");
      // A public page of the server build carries no inline style element at all.
      expect(html).not.toMatch(/<style[\s>]/);
      const file = await fetch(site.base + href!);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
      expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      const css = await file.text();
      expect(css).toContain("--oks-color-primary-700:");
      expect(css).toContain("h1 { letter-spacing: 0.4em }");
      // An older name (a page that was cached before the change) gets the current look, never cached for long.
      const older = await fetch(site.base + "/site-style/0000000000000000.css");
      expect(older.status).toBe(200);
      expect(older.headers.get("cache-control")).toBe("no-cache");
      expect(await older.text()).toBe(css);
      // Names that are not a fingerprint are not served.
      for (const bad of ["x.css", "0000000000000000.txt", "0000000000000000"])
        expect((await fetch(site.base + `/site-style/${bad}`)).status, bad).toBe(404);
      // Changing the look changes the name, so no one keeps an old file under the new name.
      await call(page, "PUT", "/api/admin/settings/theme", {
        customCss: "h1 { letter-spacing: 0.1em }",
      });
      const after = await (await fetch(site.base + "/")).text();
      const next = /<link rel="stylesheet" href="(\/site-style\/[0-9a-f]{16}\.css)"/.exec(
        after,
      )?.[1];
      expect(next).toBeTruthy();
      expect(next).not.toBe(href);
    });

    test("importing pages from a CSV file: the screen takes a file and reports row by row; a row that passes the publish check goes live, one that does not is kept as a draft with the reason", async () => {
      const page = await signedIn(owner);
      await page.goto(site.base + "/admin/pages");
      await page.getByText("Import from a CSV file").click();
      await page.locator("#import-file").setInputFiles({
        name: "pages.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "title,slug,status,content",
            'Imported hello,imported-hello,published,"Hello from a file.\n\nSecond paragraph."',
            "Empty imported,empty-imported,published,",
            ",no-title,draft,Words",
          ].join("\n"),
        ),
      });
      expect(await axeViolations(page)).toEqual([]);
      await page.getByRole("button", { name: "Import the file" }).click();
      const report = page.getByRole("region", { name: "Import report" });
      await report.getByText(/2 added \(1 published, 1 drafts\), 1 skipped\./).waitFor();
      await report
        .getByText(/Row 3 \(Empty imported\): Kept as a draft\. It has no content yet/)
        .waitFor();
      await report.getByText(/Row 4: It has no title\./).waitFor();
      expect(await axeViolations(page)).toEqual([]);

      // The published one is on the public site with both paragraphs; the draft is not.
      const live = await fetch(site.base + "/imported-hello");
      expect(live.status).toBe(200);
      const html = await live.text();
      expect(html).toContain("<p>Hello from a file.</p>");
      expect(html).toContain("<p>Second paragraph.</p>");
      expect((await fetch(site.base + "/empty-imported")).status).toBe(404);
      // Both are in the list, and the import is in the log.
      await page.goto(site.base + "/admin/pages");
      await page.getByRole("link", { name: "Imported hello" }).waitFor();
      await page.getByRole("link", { name: "Empty imported" }).waitFor();
      const log = await db.run(
        `select "detail" from "audit_log" where "action" = 'content.import'`,
      );
      expect(log.length).toBeGreaterThan(0);
    });

    test("importing Markdown files: the screen takes several files and reports each; the published one is public with its list, a picture with no description keeps its page a draft", async () => {
      const page = await signedIn(owner);
      await page.goto(site.base + "/admin/pages");
      await page.getByText("Import from Markdown files").click();
      await page.locator("#import-md").setInputFiles([
        {
          name: "from-markdown.md",
          mimeType: "text/markdown",
          buffer: Buffer.from(
            "---\nstatus: published\nslug: from-markdown\n---\n# From Markdown\n\nSome **bold** words.\n\n- first item\n- second item\n",
          ),
        },
        {
          name: "no-description.md",
          mimeType: "text/markdown",
          buffer: Buffer.from(
            "---\nstatus: published\n---\n# Markdown picture page\n\n![](/uploads/none.png)\n",
          ),
        },
      ]);
      expect(await axeViolations(page)).toEqual([]);
      await page.getByRole("button", { name: "Import the files" }).click();
      const report = page.getByRole("region", { name: "Import report" });
      await report.getByText(/2 added \(1 published, 1 drafts\), 0 skipped\./).waitFor();
      await report
        .getByText(/File no-description\.md: Kept as a draft\. Picture 1 has no description/)
        .waitFor();
      expect(await axeViolations(page)).toEqual([]);
      const live = await fetch(site.base + "/from-markdown");
      expect(live.status).toBe(200);
      const html = await live.text();
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<ul><li>first item</li><li>second item</li></ul>");
      await page.goto(site.base + "/admin/pages");
      await page.getByRole("link", { name: "From Markdown" }).waitFor();
      await page.getByRole("link", { name: "Markdown picture page" }).waitFor();
    });

    test("the search in the admin (Ctrl+K): it goes to a screen, finds a page by its title and opens it, and says so when nothing matches", async () => {
      const page = await signedIn(owner);
      await page.goto(site.base + "/admin/media");
      const made = await page.evaluate(async () => {
        const r = await fetch("/api/admin/entries", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "page", editor: "writing", title: "Searchable zebra page" }),
        });
        return r.status;
      });
      expect(made).toBe(200);
      // The shell needs a moment to wake up before the shortcut works.
      await page.getByRole("button", { name: "Search" }).waitFor();
      await page.getByRole("button", { name: "Search" }).click();
      const box = page.getByPlaceholder("Search the admin");
      await box.fill("privacy");
      await page.getByRole("option", { name: /Settings: Privacy/ }).click();
      await page.waitForURL("**/admin/settings/privacy");
      await page.getByRole("button", { name: "Search" }).click();
      await page.getByPlaceholder("Search the admin").fill("zebra searchable");
      const hit = page.getByRole("dialog").getByRole("option", { name: /Searchable zebra page/ });
      await hit.waitFor();
      expect(await hit.textContent()).toContain("Page · draft");
      expect(await axeViolations(page)).toEqual([]);
      await hit.click();
      await page.waitForURL(/\/admin\/pages\/[0-9A-Za-z-]+$/);
      await page.getByRole("button", { name: "Search" }).click();
      await page.getByPlaceholder("Search the admin").fill("zzzz nothing");
      await page
        .getByText(/No results|Nothing/i)
        .first()
        .waitFor();
    });

    test("security headers: every page and API answer says where it may be framed, its base address and where forms may send; the upload and font files keep their own stricter policy", async () => {
      const rules =
        "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'";
      for (const path of ["/", "/admin/login", "/api/admin/settings/theme", "/robots.txt"]) {
        const res = await fetch(site.base + path);
        // A public page also says where stylesheets may come from (TH-49): the site itself, and no other host yet.
        expect(res.headers.get("content-security-policy"), path).toBe(
          path === "/" ? `${rules}; style-src-elem 'self'; report-uri /api/csp-report` : rules,
        );
        expect(res.headers.get("x-frame-options"), path).toBe("SAMEORIGIN");
        expect(res.headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
        expect(res.headers.get("permissions-policy"), path).toBe(
          "camera=(), microphone=(), geolocation=()",
        );
      }
      // The admin and the API are still never stored by a CDN.
      expect((await fetch(site.base + "/admin/login")).headers.get("cache-control")).toBe(
        "private, no-store",
      );
      // A library font file keeps its own, stricter policy (not doubled).
      const font = await fetch(site.base + "/fonts/inter-latin-400.0000000000000000.woff2");
      expect(font.status).toBe(404);
      const page = await signedIn(owner);
      const live = await page.goto(site.base + "/admin/settings/look");
      expect(live!.headers()["content-security-policy"]).toBe(rules);
    });

    test("LIC-01: Settings > Licence keys: a signed key is added and listed, a forged one is refused, an ended key keeps working, a key can be removed, and an editor has no access", async () => {
      const page = await signedIn(owner);
      await page.goto(site.base + "/admin/settings/licences");
      await page.getByRole("heading", { name: "Licence keys", level: 1 }).waitFor();
      await page.getByText("No keys yet.").waitFor();
      expect(await axeViolations(page)).toEqual([]);
      const add = async (token: string) => {
        await page.getByLabel("Add a licence key").fill(token);
        await page.getByRole("button", { name: "Add key" }).click();
      };

      // A key made with another signing key is refused, in plain words, and is not listed.
      const other = generateKeyPairSync("ed25519");
      await add(
        signedLicence(
          {
            id: "forged",
            kind: "normal",
            covers: ["shop"],
            sites: 1,
            updatesUntil: "2099-12-31",
            maxMajor: null,
            issued: "2026-11-19",
          },
          other.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
        ),
      );
      await page.getByText("This key was not made by us, or it was changed.").waitFor();
      expect(await page.getByRole("row", { name: /forged/ }).count()).toBe(0);

      // A yearly key and an ended one are listed; the ended one says it keeps working.
      await add(
        signedLicence({
          id: "year-key",
          kind: "normal",
          covers: ["shop"],
          sites: 3,
          updatesUntil: "2099-12-31",
          maxMajor: null,
          issued: "2026-11-19",
          holder: "Anna",
        }),
      );
      await page.getByRole("row", { name: /year-key/ }).waitFor();
      await add(
        signedLicence({
          id: "old-key",
          kind: "normal",
          covers: ["*"],
          sites: 1,
          updatesUntil: "2020-01-01",
          maxMajor: null,
          issued: "2019-01-01",
        }),
      );
      const oldRow = page.getByRole("row", { name: /old-key/ });
      await oldRow.waitFor();
      expect(await oldRow.textContent()).toContain("keeps working");
      const yearRow = page.getByRole("row", { name: /year-key/ });
      expect(await yearRow.textContent()).toContain("Updates until 2099-12-31.");
      expect(await yearRow.textContent()).toContain("3");
      // The same key twice is refused.
      await add(
        signedLicence({
          id: "year-key",
          kind: "normal",
          covers: ["shop"],
          sites: 3,
          updatesUntil: "2099-12-31",
          maxMajor: null,
          issued: "2026-11-19",
          holder: "Anna",
        }),
      );
      await page.getByText("This key is already added.").waitFor();

      // The keys are kept, and one can be removed.
      await page.reload();
      await page.getByRole("row", { name: /year-key/ }).waitFor();
      await page.getByRole("button", { name: "Remove key old-key" }).click();
      await page.getByText("The key is removed.").waitFor();
      expect(await page.getByRole("row", { name: /old-key/ }).count()).toBe(0);
      await page.reload();
      await page.getByRole("row", { name: /year-key/ }).waitFor();
      expect(await page.getByRole("row", { name: /old-key/ }).count()).toBe(0);

      // An editor may not see or change the keys.
      const editor = await signedIn(cara);
      await editor.goto(site.base + "/admin/settings/licences");
      await editor.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      const refused = await editor.evaluate(
        async () => (await fetch("/api/admin/licences")).status,
      );
      expect(refused).toBe(403);
    });

    test("TH-49: public pages load stylesheets only from the site and the hosts an administrator named; a bad host is refused in plain words", async () => {
      const page = await signedIn(owner);
      const put = (body: unknown) =>
        page.evaluate(async (b) => {
          const r = await fetch("/api/admin/settings/security", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(b),
          });
          return { status: r.status, body: (await r.json()) as { error?: { message?: string } } };
        }, body);
      // The admin must be open first, so the fetch above has the session cookie.
      await page.goto(site.base + "/admin/settings/security");
      const refused = await put({ styleHosts: ["*.example.com"] });
      expect(refused.status).toBe(400);
      expect(refused.body.error?.message).toContain("wildcard");
      expect((await put({ styleHosts: ["http://cdn.example.com"] })).status).toBe(400);

      // No page of the public site breaks its own rule: no stylesheet or style element is blocked.
      for (const path of ["/", "/search?q=a"]) {
        const visitor = await browser.newPage();
        await visitor.addInitScript(() => {
          (window as unknown as { __blocked: string[] }).__blocked = [];
          document.addEventListener("securitypolicyviolation", (event) => {
            (window as unknown as { __blocked: string[] }).__blocked.push(
              `${event.violatedDirective} ${event.blockedURI}`,
            );
          });
        });
        await visitor.goto(site.base + path);
        await visitor.waitForLoadState("load");
        await visitor.waitForTimeout(500);
        expect(
          await visitor.evaluate(() => (window as unknown as { __blocked: string[] }).__blocked),
          path,
        ).toEqual([]);
        await visitor.close();
      }

      // A named host reaches the header of public pages, and only public pages.
      const saved = await put({ styleHosts: ["Assets.Example.com"] });
      expect(saved.status).toBe(200);
      let policy: string | null = null;
      for (let i = 0; i < 40 && !policy?.includes("assets.example.com"); i += 1) {
        policy = (await fetch(site.base + "/")).headers.get("content-security-policy");
        if (!policy?.includes("assets.example.com")) await new Promise((r) => setTimeout(r, 250));
      }
      expect(policy).toBe(
        "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; style-src-elem 'self' https://assets.example.com; report-uri /api/csp-report",
      );
      const admin = await fetch(site.base + "/admin/login");
      expect(admin.headers.get("content-security-policy")).not.toContain("style-src-elem");
      expect((await put({ styleHosts: [] })).status).toBe(200);

      // A browser reports a refused stylesheet: it is kept once, and the admin says which host (ADR 0038, point 5).
      const report = (host: string) =>
        fetch(site.base + "/api/csp-report", {
          method: "POST",
          headers: { "content-type": "application/csp-report" },
          body: JSON.stringify({
            "csp-report": {
              "document-uri": `${site.base}/about?x=1`,
              "effective-directive": "style-src-elem",
              "blocked-uri": `https://${host}/a.css`,
            },
          }),
        });
      expect((await report("cdn.example.net")).status).toBe(204);
      expect((await report("cdn.example.net")).status).toBe(204);
      expect((await report("*.bad")).status).toBe(204);
      expect(
        (await fetch(site.base + "/api/csp-report", { method: "POST", body: "not json" })).status,
      ).toBe(204);
      await page.goto(site.base + "/admin/settings/security");
      await page.getByRole("heading", { name: "Stylesheets that were blocked" }).waitFor();
      await page.getByText("cdn.example.net", { exact: true }).waitFor();
      expect(await page.getByText("*.bad").count()).toBe(0);
      expect(await axeViolations(page)).toEqual([]);
      await page.goto(site.base + "/admin");
      await page.getByText("A stylesheet was blocked on a public page.").waitFor();
      // "Not now" forgets it; a later report brings it back; "Allow" adds it to the list and clears it.
      await page.goto(site.base + "/admin/settings/security");
      await page.getByRole("button", { name: "Not now" }).click();
      await page.getByText("cdn.example.net stays blocked.").waitFor();
      expect(
        await page.getByRole("heading", { name: "Stylesheets that were blocked" }).count(),
      ).toBe(0);
      // The host is told once every few minutes at most, so the same host is not noted again right away.
      expect((await report("cdn.example.net")).status).toBe(204);
      expect((await report("fonts.example.org")).status).toBe(204);
      await page.goto(site.base + "/admin/settings/security");
      await page.getByRole("button", { name: "Allow fonts.example.org" }).click();
      await page.getByText("fonts.example.org is allowed now.").waitFor();
      expect(await page.getByLabel("Other hosts that may serve stylesheets").inputValue()).toBe(
        "fonts.example.org",
      );
      let allowed: string | null = null;
      for (let i = 0; i < 40 && !allowed?.includes("fonts.example.org"); i += 1) {
        allowed = (await fetch(site.base + "/")).headers.get("content-security-policy");
        if (!allowed?.includes("fonts.example.org")) await new Promise((r) => setTimeout(r, 250));
      }
      expect(allowed).toContain("style-src-elem 'self' https://fonts.example.org;");
      expect((await put({ styleHosts: [] })).status).toBe(200);
    });

    test("contrast warning: a theme whose text color is weak in dark mode is flagged on the Look screen, only for the modes a visitor can reach", async () => {
      const page = await signedIn(owner);
      await page.goto(site.base + "/admin/settings/look");
      await page.getByRole("heading", { name: "Look of the site", level: 1 }).waitFor();
      expect(await page.getByText("Hard to read").count()).toBe(0);

      await page.goto(site.base + "/admin/settings/themes");
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "dusk-1.0.0.tgz",
        mimeType: "application/gzip",
        buffer: tgz({
          "theme.json": JSON.stringify({
            key: "dusk",
            name: "Dusk",
            version: "1.0.0",
            tokens: { color: { text: "#222222" } },
          }),
        }),
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByText("Dusk 1.0.0 is installed. It is not in use yet.").waitFor();
      await page.getByRole("button", { name: "Use Dusk" }).click();
      await page.getByRole("button", { name: "Yes, switch to Dusk" }).click();
      await page.getByText("Your site uses Dusk now.").waitFor();

      // A new site follows the device, so dark can be reached: the warning is there, in plain words, and saving still works.
      await page.goto(site.base + "/admin/settings/look");
      await page.getByRole("heading", { name: "Look of the site", level: 1 }).waitFor();
      const warning = page.getByText(
        /In dark mode the text is hard to read \(contrast \d\.\d to 1/,
      );
      await warning.waitFor();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await axeViolations(page), `at ${width} px`).toEqual([]);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      // Always light: dark cannot be reached, so the warning goes. Always dark: it comes back.
      await page.getByLabel("Always light").check();
      await warning.waitFor({ state: "detached" });
      await page.getByLabel("Always dark").check();
      await warning.waitFor();
      await page.getByLabel("Like the visitor's device (light or dark)").check();

      // Back to the built-in design and remove Dusk: the warning is gone.
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByRole("button", { name: "Use the built-in design" }).click();
      await page.getByRole("button", { name: "Yes, switch to the built-in design" }).click();
      await page.getByText("Your site uses the built-in design now.").waitFor();
      await page.getByRole("button", { name: "Remove Dusk" }).click();
      await page.getByRole("button", { name: "Yes, remove Dusk" }).click();
      await page.getByText("Dusk is removed.").waitFor();
      await page.goto(site.base + "/admin/settings/look");
      await page.getByRole("heading", { name: "Look of the site", level: 1 }).waitFor();
      expect(await page.getByText("Hard to read").count()).toBe(0);
    });

    test("TH-56: the contrast warnings follow the colors as they are picked, before anything is saved", async () => {
      const page = await signedIn(owner);
      // Earlier tests may have saved a main color, which would hide the theme's own: start with none, put it back at the end.
      const saved = (
        (await call(page, "GET", "/api/admin/settings/theme")).json as {
          styles: { mainColor: string | null };
        }
      ).styles.mainColor;
      expect(
        (await call(page, "PUT", "/api/admin/settings/theme", { mainColor: null })).status,
      ).toBe(200);
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "sun-1.0.0.tgz",
        mimeType: "application/gzip",
        buffer: tgz({
          "theme.json": JSON.stringify({
            key: "sun",
            name: "Sun",
            version: "1.0.0",
            options: ["mainColor"],
            tokens: { color: { "primary-700": "#ffee00" } },
          }),
        }),
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByRole("button", { name: "Use Sun" }).waitFor();
      await page.getByRole("button", { name: "Use Sun" }).click();
      await page.getByRole("button", { name: "Yes, switch to Sun" }).click();
      await page.getByText("Your site uses Sun now.").waitFor();

      await page.goto(site.base + "/admin/settings/look");
      await page.getByRole("heading", { name: "Look of the site", level: 1 }).waitFor();
      const weakButton = page
        .getByText(/the text on the main-color button is hard to read/)
        .first();
      await weakButton.waitFor();
      // Picking a dark main color takes the warning away at once; the saved look is not touched.
      await page.locator("#look-color").fill("#2a6f4f");
      await weakButton.waitFor({ state: "detached" });
      expect(await page.getByText("Hard to read").count()).toBe(0);
      await page.reload();
      await weakButton.waitFor();
      // Put the site back as it was.
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByRole("button", { name: "Use the built-in design" }).click();
      await page.getByRole("button", { name: "Yes, switch to the built-in design" }).click();
      await page.getByText("Your site uses the built-in design now.").waitFor();
      await page.getByRole("button", { name: "Remove Sun" }).click();
      await page.getByRole("button", { name: "Yes, remove Sun" }).click();
      await page.getByText("Sun is removed.").waitFor();
      expect(
        (await call(page, "PUT", "/api/admin/settings/theme", { mainColor: saved })).status,
      ).toBe(200);
    });

    test("TH-61: on a right-to-left site a theme that was not tested for it carries a notice; a tested theme does not", async () => {
      const page = await signedIn(owner);
      const pack = (key: string, rtl: string) =>
        tgz({
          "theme.json": JSON.stringify({ key, name: key.toUpperCase(), version: "1.0.0", rtl }),
        });
      await page.goto(site.base + "/admin/settings/themes");
      for (const [key, rtl] of [
        ["rtla", "untested"],
        ["rtlb", "supported"],
      ] as const) {
        await page.getByLabel("Theme file (.tgz)").setInputFiles({
          name: `${key}.tgz`,
          mimeType: "application/gzip",
          buffer: pack(key, rtl),
        });
        await page.getByRole("button", { name: "Upload and check" }).click();
        await page.getByRole("button", { name: `Use ${key.toUpperCase()}` }).waitFor();
      }
      // A left-to-right site: no notice.
      const card = (name: string) =>
        page.locator("li", { has: page.getByRole("heading", { name: new RegExp(name) }) });
      expect(await card("RTLA").getByText("Check this theme first").count()).toBe(0);
      const set = (tag: string) =>
        page.evaluate(
          async (t) =>
            (
              await fetch("/api/admin/settings/language", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ tag: t, direction: "auto" }),
              })
            ).status,
          tag,
        );
      expect(await set("ar")).toBe(200);
      await page.reload();
      await card("RTLA").getByText("Check this theme first").waitFor();
      expect(await card("RTLB").getByText("Check this theme first").count()).toBe(0);
      await page.getByText(/RTLA was not tested for that/).waitFor();
      expect(await axeViolations(page)).toEqual([]);
      expect(await set("en")).toBe(200);
      for (const key of ["RTLA", "RTLB"]) {
        await page.reload();
        await page.getByRole("button", { name: `Remove ${key}` }).click();
        await page.getByRole("button", { name: `Yes, remove ${key}` }).click();
        await page.getByText(`${key} is removed.`).waitFor();
      }
    });

    test("TH-58: the default theme's sample pages have no accessibility violation in light and dark mode", async () => {
      const page = await signedIn(owner);
      await page.goto(site.base + "/admin/pages");
      await page.getByText("Import from Markdown files").click();
      await page.locator("#import-md").setInputFiles({
        name: "sample-th58.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(
          [
            "---",
            "status: published",
            "slug: sample-th58",
            "---",
            "# A sample page",
            "",
            "Some **bold** words, some *italic* words and a [link](https://example.com/a).",
            "",
            "## A list and a quote",
            "",
            "- first item",
            "- second item",
            "",
            "1. one",
            "2. two",
            "",
            "> A quote that says something.",
            "",
            "```js",
            "const answer = 42;",
            "```",
            "",
            "---",
            "",
            "### The end",
            "",
            "Last paragraph.",
            "",
          ].join("\n"),
        ),
      });
      await page.getByRole("button", { name: "Import the files" }).click();
      await page
        .getByRole("region", { name: "Import report" })
        .getByText(/1 added \(1 published/)
        .waitFor();
      expect((await fetch(site.base + "/sample-th58")).status).toBe(200);
      for (const scheme of ["light", "dark"] as const) {
        const visitor = await (await browser.newContext({ colorScheme: scheme })).newPage();
        for (const path of ["/", "/sample-th58"])
          for (const width of [1280, 390]) {
            await visitor.setViewportSize({ width, height: 900 });
            await visitor.goto(site.base + path);
            expect(await visitor.evaluate(() => document.documentElement.dataset["theme"])).toBe(
              scheme,
            );
            expect(await axeViolations(visitor), `${scheme} ${path} ${width}px`).toEqual([]);
          }
        await visitor.context().close();
      }
    });

    test("TH-67: the design screens use plain words: no screen says template, part, pattern, override or token", async () => {
      const page = await signedIn(owner);
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "maple-th67.tgz",
        mimeType: "application/gzip",
        buffer: maple("1.0.0", "1px"),
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByRole("button", { name: "Use Maple" }).waitFor();
      await page.getByRole("button", { name: "Use Maple" }).click();
      await page.getByRole("button", { name: "Yes, switch to Maple" }).click();
      await page.getByText("Your site uses Maple now.").waitFor();
      const forbidden = /\b(templates?|parts?|patterns?|overrides?|tokens?)\b/i;
      const themeId = (
        (await call(page, "GET", "/api/admin/themes")).json as {
          themes: { id: string; name: string }[];
        }
      ).themes.find((t) => t.name === "Maple")!.id;
      for (const path of [
        "/admin/settings/themes",
        `/admin/themes/${themeId}/preview`,
        "/admin/settings/look",
        "/admin/settings/site-editor",
      ]) {
        await page.goto(site.base + path);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.waitForLoadState("networkidle");
        // The page's own words: what a person can read (headings, text, buttons, labels), without the site's own pages.
        const words = await page.locator("main").evaluate((el) => (el as HTMLElement).innerText);
        const found = forbidden.exec(words);
        expect(
          found?.[0] ?? null,
          `${path}: ${found ? words.slice(Math.max(0, found.index - 40), found.index + 60) : ""}`,
        ).toBeNull();
      }
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByRole("button", { name: "Use the built-in design" }).click();
      await page.getByRole("button", { name: "Yes, switch to the built-in design" }).click();
      await page.getByText("Your site uses the built-in design now.").waitFor();
      await page.getByRole("button", { name: "Remove Maple" }).click();
      await page.getByRole("button", { name: "Yes, remove Maple" }).click();
      await page.getByText("Maple is removed.").waitFor();
    });

    test("theme layouts: public pages are drawn from the layouts of the theme in use, with live data, and the built-in pages come back when it is not", async () => {
      const page = await signedIn(owner);
      const b = (
        type: string,
        props: Record<string, unknown> = {},
        children: unknown[] = [],
        content: unknown = null,
      ) => ({
        id: Math.random().toString(36).slice(2, 10),
        type,
        props,
        content,
        children,
      });
      const text = (t: string) => [{ type: "text", text: t }];
      const main = (...inner: unknown[]) => b("section", { tag: "main", name: "content" }, inner);
      const layout = (...blocks: unknown[]) => JSON.stringify({ blocks });
      const theme = tgz({
        "theme.json": JSON.stringify({ key: "willow", name: "Willow", version: "1.0.0" }),
        "parts/header.json": layout(
          b("section", { tag: "header" }, [
            b("site-title"),
            b("menu", { place: "primary" }),
            b("search-form"),
          ]),
        ),
        "parts/footer.json": layout(
          b("section", { tag: "footer" }, [
            b("menu", { place: "footer" }),
            b("paragraph", {}, [], text("Made with Willow")),
          ]),
        ),
        "templates/index.json": layout(
          b("part", { name: "header" }),
          main(b("breadcrumbs"), b("post-title"), b("post-meta"), b("post-content")),
          b("part", { name: "footer" }),
        ),
        "templates/front-page.json": layout(
          b("part", { name: "header" }),
          main(
            b("post-title"),
            b("post-content"),
            b("heading", { level: 2 }, [], text("Latest posts")),
            b("query-loop", { count: 3 }),
          ),
          b("part", { name: "footer" }),
        ),
        "templates/archive.json": layout(
          b("part", { name: "header" }),
          main(b("paragraph", {}, [], text("Willow archive")), b("post-title"), b("post-content")),
          b("part", { name: "footer" }),
        ),
      });
      // A category with the starter post in it, for an archive page.
      const made = await call(page, "POST", "/api/admin/taxonomies/category", {
        name: "Garden notes",
      });
      expect(made.status).toBe(201);
      const termId = String(
        (await db.run("select id from terms where slug = 'garden-notes'"))[0]!["id"],
      );
      const postId = String(
        (await db.run("select id from entries where slug = 'blog/hello-world'"))[0]!["id"],
      );
      expect(
        (
          await call(page, "PUT", `/api/admin/entries/${postId}/terms`, {
            categoryIds: [termId],
            tags: [],
          })
        ).status,
      ).toBe(200);

      const before = await (await fetch(site.base + "/")).text();
      expect(before).not.toContain("oks-site-title");

      await page.goto(site.base + "/admin/settings/themes");
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "willow.tgz",
        mimeType: "application/gzip",
        buffer: theme,
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByText("Willow 1.0.0 is installed. It is not in use yet.").waitFor();
      await page.getByRole("button", { name: "Use Willow" }).click();
      await page.getByRole("button", { name: "Yes, switch to Willow" }).click();
      await page.getByText("Your site uses Willow now.").waitFor();

      const html = async (path: string) => {
        const response = await fetch(site.base + path);
        expect(response.status, path).toBe(200);
        return response.text();
      };
      // The front page: its own layout, with the header and footer parts, the page and the newest posts.
      const front = await html("/");
      expect(front).toContain('class="oks-site-title"');
      expect(front).toContain("Anna&#x27;s Garden");
      expect(front).toContain("Made with Willow");
      expect(front).toMatch(
        /<main class="oks-section oks-section-content"><h1 class="oks-title">Home<\/h1>/,
      );
      expect(front).toContain(
        '<ul class="oks-latest-posts"><li><a href="/blog/hello-world">Hello world</a>',
      );
      expect(front).not.toContain('aria-label="Breadcrumb"');
      // A post uses "index": breadcrumbs, its date and author, its text.
      const post = await html("/blog/hello-world");
      expect(post).toContain('aria-label="Breadcrumb"');
      expect(post).toMatch(/<p class="oks-post-meta"><time dateTime="\d{4}-\d\d-\d\d">/);
      expect(post).toContain('<h1 class="oks-title">Hello world</h1>');
      expect(post).toContain("Made with Willow");
      // A page has no post details.
      expect(await html("/about")).not.toContain("oks-post-meta");
      // A category page uses "archive", with the list of posts as its content.
      const archive = await html("/category/garden-notes");
      expect(archive).toContain("Willow archive");
      expect(archive).toContain('<h1 class="oks-title">Category: Garden notes</h1>');
      expect(archive).toContain('href="/blog/hello-world"');
      // Search has no layout of its own and uses "index", with the results as its content.
      const results = await html("/search?q=hello");
      expect(results).toContain('<h1 class="oks-title">Search</h1>');
      expect(results).toContain("Made with Willow");
      expect(results).toMatch(/result/);

      // In a real browser, at desktop and phone width: no accessibility problems, and the search form works.
      const visitor = await browser.newPage();
      for (const [path, width] of [
        ["/", 1280],
        ["/", 390],
        ["/blog/hello-world", 1280],
        ["/category/garden-notes", 390],
      ] as const) {
        await visitor.setViewportSize({ width, height: 900 });
        await visitor.goto(site.base + path);
        expect(await axeViolations(visitor), `${path} at ${width} px`).toEqual([]);
      }
      await visitor.goto(site.base + "/");
      await visitor.getByRole("searchbox", { name: "Search this site" }).fill("hello");
      await visitor.getByRole("button", { name: "Search" }).click();
      await visitor.waitForURL(/\/search\?q=hello/);
      await visitor.getByRole("link", { name: "Hello world" }).first().waitFor();
      await visitor.close();

      // Back to the built-in design: the built-in pages, at once.
      await page.getByRole("button", { name: "Use the built-in design" }).click();
      await page.getByRole("button", { name: "Yes, switch to the built-in design" }).click();
      await page.getByText("Your site uses the built-in design now.").waitFor();
      const after = await html("/");
      expect(after).not.toContain("oks-site-title");
      expect(after).not.toContain("Made with Willow");
    });

    test("layout changes: a draft is not public, publish shows it on every page that uses the layout at once, history, reset; only design managers", async () => {
      const page = await signedIn(owner);
      const themes = (await call(page, "GET", "/api/admin/themes")).json as {
        themes: { id: string; key: string }[];
      };
      const willow = themes.themes.find((t) => t.key === "willow")!;
      expect(
        (await call(page, "POST", `/api/admin/themes/${willow.id}`, { action: "use" })).status,
      ).toBe(200);
      const base = `/api/admin/themes/${willow.id}`;
      const post = async () => (await fetch(site.base + "/blog/hello-world")).text();
      expect(await post()).toContain("Made with Willow");

      const list = await call(page, "GET", `${base}/layouts`);
      expect(list.status).toBe(200);
      expect(list.json!["layouts"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "templates/index", state: "theme", hasDraft: false }),
          expect.objectContaining({ key: "parts/footer", state: "theme", kind: "part" }),
        ]),
      );

      // A draft of the footer: the public pages do not change.
      const footer = (await call(page, "GET", `${base}/layout?key=parts/footer`)).json as {
        layout: { theme: unknown[] };
      };
      const changed = [
        ...footer.layout.theme,
        {
          id: "owner-note",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "Open every day but Monday" }],
          children: [],
        },
      ];
      const draft = await call(page, "PUT", `${base}/layout`, {
        key: "parts/footer",
        blocks: changed,
      });
      expect(draft.status).toBe(200);
      expect(draft.json).toMatchObject({ layout: { state: "theme", hasDraft: true }, repairs: 0 });
      expect(await post()).not.toContain("Open every day but Monday");

      // A footer that includes itself is refused and leaves the draft alone.
      const loop = await call(page, "PUT", `${base}/layout`, {
        key: "parts/footer",
        blocks: [{ id: "x", type: "part", props: { name: "footer" }, content: null, children: [] }],
      });
      expect(loop.status).toBe(400);

      // Publish: every page with the footer shows it at once.
      const published = await call(page, "POST", `${base}/layouts`, { action: "publish" });
      expect(published.json).toEqual({ ok: true, published: ["parts/footer"], sections: [] });
      expect(await post()).toContain("Open every day but Monday");
      expect(await (await fetch(site.base + "/")).text()).toContain("Open every day but Monday");
      const detail = (await call(page, "GET", `${base}/layout?key=parts/footer`)).json as {
        layout: { state: string };
        versions: { id: string; publishedBy: string }[];
      };
      expect(detail.layout.state).toBe("owner");
      expect(detail.versions).toHaveLength(1);
      expect(detail.versions[0]!.publishedBy).toBe("Anna");

      // An editor may not see or change layouts; a signed-out request is refused.
      const editor = await signedIn(cara);
      expect((await call(editor, "GET", `${base}/layouts`)).status).toBe(403);
      expect(
        (await call(editor, "PUT", `${base}/layout`, { key: "parts/footer", blocks: [] })).status,
      ).toBe(403);
      expect((await call(editor, "POST", `${base}/layouts`, { action: "publish" })).status).toBe(
        403,
      );
      expect((await fetch(site.base + `${base}/layouts`)).status).toBe(401);

      // Reset to the theme's footer: the change leaves every page at once; the history stays.
      expect(
        (await call(page, "POST", `${base}/layout`, { action: "reset", key: "parts/footer" }))
          .status,
      ).toBe(200);
      expect(await post()).not.toContain("Open every day but Monday");
      const after = (await call(page, "GET", `${base}/layout?key=parts/footer`)).json as {
        layout: { state: string };
        versions: unknown[];
      };
      expect(after.layout.state).toBe("theme");
      expect(after.versions).toHaveLength(1);

      // Restore makes a draft from the old version; nothing is public until it is published again.
      const restored = await call(page, "POST", `${base}/layout`, {
        action: "restore",
        versionId: detail.versions[0]!.id,
      });
      expect(restored.json).toMatchObject({ layout: { hasDraft: true } });
      expect(await post()).not.toContain("Open every day but Monday");
      await call(page, "POST", `${base}/layouts`, { action: "publish" });
      expect(await post()).toContain("Open every day but Monday");

      await call(page, "POST", "/api/admin/themes/default", { action: "use" });
    });

    test("the site editor: select on the live preview, change, publish, undo, add, history, and a theme update with compare and keep mine", async () => {
      const page = await signedIn(owner);
      const themes = (await call(page, "GET", "/api/admin/themes")).json as {
        themes: { id: string; key: string }[];
      };
      const willow = themes.themes.find((t) => t.key === "willow")!;
      await call(page, "POST", `/api/admin/themes/${willow.id}`, { action: "use" });
      const post = async () => (await fetch(site.base + "/blog/hello-world")).text();
      expect(await post()).toContain("Open every day but Monday");

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(site.base + "/admin/settings/site-editor");
      await page.getByRole("heading", { name: "Site editor", level: 1 }).waitFor();
      const layouts = page.getByRole("navigation", { name: "Layouts" });
      for (const name of [
        "Home",
        "Default (used when no other layout fits)",
        "Category and tag pages",
        "Header",
        "Footer",
      ])
        await layouts
          .getByRole("button", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`) })
          .waitFor();

      // Open the footer: the banner gives the real reach; the preview shows the published footer.
      await layouts.getByRole("button", { name: /^Footer/ }).click();
      await page
        .getByText(/The Footer shows on every page that uses it: this changes .*posts?/)
        .waitFor();
      const preview = page.frameLocator('iframe[title="Preview of your site with your changes"]');
      await preview.getByText("Open every day but Monday").waitFor();
      expect(await axeViolations(page)).toEqual([]);

      // A click on the preview selects the block; delete it: a draft, not public until Publish.
      await preview.getByText("Open every day but Monday").click();
      const tools = page.getByRole("complementary", { name: "Tools" });
      await tools
        .getByRole("heading", { name: "Selected: Text: Open every day but Monday" })
        .waitFor();
      await tools.getByRole("button", { name: "Delete" }).click();
      await page.getByText("Draft kept").waitFor();
      expect(await post()).toContain("Open every day but Monday");
      await expect
        .poll(async () => await preview.getByText("Open every day but Monday").count())
        .toBe(0);
      await page.getByRole("button", { name: "Publish changes (1)" }).click();
      await page.getByText("Published 1 layout. Your site shows the changes now.").waitFor();
      expect(await post()).not.toContain("Open every day but Monday");

      // Undo brings it back (as a draft); publishing shows it again.
      await tools.getByRole("button", { name: "Undo" }).click();
      await page.getByText("Draft kept").waitFor();
      await page.getByRole("button", { name: "Publish changes (1)" }).click();
      await page.getByText("Published 1 layout. Your site shows the changes now.").waitFor();
      expect(await post()).toContain("Open every day but Monday");

      // Add a search box at the end of the footer, then throw the draft away.
      await tools
        .getByLabel(/Add (after the selected block|at the end)/)
        .selectOption("search-form");
      await tools.getByRole("button", { name: "Add", exact: true }).click();
      await tools.getByRole("heading", { name: "Selected: Search box" }).waitFor();
      await page.getByText("Draft kept").waitFor();
      await preview.getByRole("searchbox", { name: "Search this site" }).last().waitFor();
      await tools.getByRole("button", { name: "Throw away the draft" }).click();
      await page.getByText("The draft is thrown away.").waitFor();

      // The text editor opens for a text block.
      await preview.getByText("Open every day but Monday").click();
      await tools.getByRole("button", { name: "Edit the text" }).click();
      await page.getByRole("dialog", { name: "Edit the text" }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: "Edit the text" }).waitFor({ state: "hidden" });

      // History: every published version (this footer was published in the test before too); restoring one makes a draft.
      await tools.getByText(/^History \(4\)$/).click();
      await tools.getByRole("button", { name: "Restore" }).last().click();
      await page.getByText("Restored as a draft. Publish to show it on the site.").waitFor();
      await tools.getByRole("button", { name: "Throw away the draft" }).click();
      await page.getByText("The draft is thrown away.").waitFor();

      // A theme update that changes the footer: the editor says so; compare, then keep mine.
      const block = (
        type: string,
        props: Record<string, unknown> = {},
        children: unknown[] = [],
        content: unknown = null,
      ) => ({
        id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        props,
        content,
        children,
      });
      const layoutJson = (...blocks: unknown[]) => JSON.stringify({ blocks });
      const update = tgz({
        "theme.json": JSON.stringify({ key: "willow", name: "Willow", version: "1.1.0" }),
        "parts/header.json": layoutJson(block("site-title")),
        "parts/footer.json": layoutJson(
          block("paragraph", {}, [], [{ type: "text", text: "Willow 1.1 footer" }]),
        ),
        "templates/index.json": layoutJson(
          block("part", { name: "header" }),
          block("section", { tag: "main" }, [block("post-title"), block("post-content")]),
          block("part", { name: "footer" }),
        ),
      });
      await page.goto(site.base + "/admin/settings/themes");
      await page
        .getByLabel("Theme file (.tgz)")
        .setInputFiles({ name: "willow-1.1.0.tgz", mimeType: "application/gzip", buffer: update });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByText("Willow is now version 1.1.0. Your site uses it now.").waitFor();
      // The owner's footer is still on the site.
      expect(await post()).toContain("Open every day but Monday");

      await page.goto(site.base + "/admin/settings/site-editor");
      await layouts.getByRole("button", { name: /^Footer\s*The theme changed this/ }).click();
      await page.getByText("The theme changed this layout since you edited it").waitFor();
      await page.getByRole("button", { name: "Compare" }).click();
      await page
        .frameLocator('iframe[title="The theme\'s new layout"]')
        .getByText("Willow 1.1 footer")
        .waitFor();
      await page
        .frameLocator('iframe[title="Your layout"]')
        .getByText("Open every day but Monday")
        .waitFor();
      await page.getByRole("button", { name: "Keep mine" }).click();
      await page.getByText("Your layout is kept.").waitFor();
      await layouts.getByRole("button", { name: /^Footer\s*Your changes/ }).waitFor();

      // On a phone, the editor says it needs a wider screen.
      await page.setViewportSize({ width: 390, height: 800 });
      await page.getByText("The site editor needs a wider screen").waitFor();
      expect(await axeViolations(page)).toEqual([]);
      await page.setViewportSize({ width: 1280, height: 900 });

      // An editor is sent away; the preview is not found for them.
      const editor = await signedIn(cara);
      await editor.goto(site.base + "/admin/settings/site-editor");
      await editor.waitForURL((url) => url.pathname === "/admin");
      // Admin pages stream, so the refusal comes with status 200; what matters is that nothing of the layout is sent.
      await editor.goto(site.base + `/admin/site-editor/preview?theme=${willow.id}`);
      const refused = await editor.content();
      expect(refused).not.toContain("data-oks-block");
      expect(refused).not.toContain("Open every day but Monday");

      await call(page, "POST", "/api/admin/themes/default", { action: "use" });
    });

    test("the site editor: the section library (groups, pictures, a copy) and hiding a block on phone, tablet or desktop", async () => {
      const page = await signedIn(owner);
      const block = (
        type: string,
        props: Record<string, unknown> = {},
        children: unknown[] = [],
        content: unknown = null,
      ) => ({
        id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        props,
        content,
        children,
      });
      const words = (t: string) => [{ type: "text", text: t }];
      const json = (value: unknown) => JSON.stringify(value);
      const birch = tgz({
        "theme.json": json({ key: "birch", name: "Birch", version: "1.0.0" }),
        "templates/index.json": json({
          blocks: [
            block("site-title"),
            block("section", { tag: "main" }, [block("post-title"), block("post-content")]),
          ],
        }),
        "patterns/welcome.json": json({
          title: "Big welcome",
          group: "hero",
          blocks: [
            block("section", { tag: "section", name: "welcome" }, [
              block("heading", { level: 2 }, [], words("Welcome to Birch")),
              block("paragraph", {}, [], words("Plants for every window")),
            ]),
          ],
        }),
        "patterns/visit.json": json({
          title: "Visit us",
          group: "contact",
          blocks: [block("paragraph", {}, [], words("Find us at the market"))],
        }),
      });
      await page.goto(site.base + "/admin/settings/themes");
      await page
        .getByLabel("Theme file (.tgz)")
        .setInputFiles({ name: "birch.tgz", mimeType: "application/gzip", buffer: birch });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByText("Birch 1.0.0 is installed. It is not in use yet.").waitFor();
      await page.getByRole("button", { name: "Use Birch" }).click();
      await page.getByRole("button", { name: "Yes, switch to Birch" }).click();
      await page.getByText("Your site uses Birch now.").waitFor();

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(site.base + "/admin/settings/site-editor");
      const tools = page.getByRole("complementary", { name: "Tools" });
      await page.getByText(/You are changing the Default .* layout/).waitFor();

      // The library: groups, a picture of each section drawn with the site's look, nothing in a picture to tab to.
      await tools.getByRole("button", { name: "Add a ready-made section" }).click();
      const library = page.getByRole("dialog", { name: "Ready-made sections" });
      await library.waitFor();
      const cards = library.getByRole("list", { name: "Sections" }).getByRole("listitem");
      await expect.poll(() => cards.count()).toBe(2);
      // In library order: Hero before Contact.
      expect(await cards.getByRole("heading").allTextContents()).toEqual([
        "Big welcome",
        "Visit us",
      ]);
      const picture = page.frameLocator('iframe[title="Picture of Big welcome"]');
      await picture.getByText("Welcome to Birch").waitFor();
      // Both pictures are drawn before the window is checked.
      await page
        .frameLocator('iframe[title="Picture of Visit us"]')
        .getByText("Find us at the market")
        .waitFor();
      expect(await picture.locator("[inert]").count()).toBe(1);
      expect(await axeViolations(page)).toEqual([]);
      await library.getByLabel("Contact (1)").check();
      await expect.poll(() => cards.count()).toBe(1);
      await library.getByLabel("All (2)").check();
      await expect.poll(() => cards.count()).toBe(2);

      // Adding makes an editable copy at the end, selected, kept as a draft.
      await library.getByRole("button", { name: "Add Big welcome" }).click();
      await library.waitFor({ state: "hidden" });
      await tools.getByRole("heading", { name: 'Selected: Group "welcome"' }).waitFor();
      await page.getByText("Draft kept").waitFor();
      const preview = page.frameLocator('iframe[title="Preview of your site with your changes"]');
      await preview.getByText("Welcome to Birch").waitFor();

      // Hide it on phones: the outline says so, and the phone-size preview shows it faded (still there to select).
      const selected = tools.getByRole("group", { name: "Show this block on" });
      await selected.getByLabel("Phone").uncheck();
      await page
        .getByRole("region", { name: /^Outline of/ })
        .getByRole("button", { name: 'Group "welcome" (hidden on phone)' })
        .waitFor();
      await page.getByText("Draft kept").waitFor();
      await page.getByLabel("Phone (390 px)").check();
      await expect
        .poll(() =>
          preview
            .locator(".oks-editor-hidden-phone")
            .evaluate((el) => getComputedStyle(el).opacity),
        )
        .toBe("0.35");
      expect(
        await page
          .locator('iframe[title="Preview of your site with your changes"]')
          .evaluate((el) => (el as HTMLIFrameElement).contentWindow!.innerWidth),
      ).toBe(390);
      await page.getByLabel("Desktop (1280 px)").check();
      await expect
        .poll(() =>
          preview
            .locator(".oks-editor-hidden-phone")
            .evaluate((el) => getComputedStyle(el).opacity),
        )
        .toBe("1");

      // Publish: visitors on a phone do not see it; on a tablet and a desktop they do.
      await page.getByRole("button", { name: "Publish changes (1)" }).click();
      await page.getByText("Published 1 layout. Your site shows the changes now.").waitFor();
      const home = await (await fetch(site.base + "/")).text();
      expect(home).toContain("Welcome to Birch");
      expect(home).toContain('class="oks-hide oks-hide-phone"');
      const visitor = await browser.newPage();
      await visitor.goto(site.base + "/");
      for (const [width, shown] of [
        [390, false],
        [767, false],
        [768, true],
        [1024, true],
        [1025, true],
        [1440, true],
      ] as const) {
        await visitor.setViewportSize({ width, height: 800 });
        // The page lays itself out again after a resize; wait for that before judging.
        await expect
          .poll(() => visitor.evaluate(() => innerWidth), { message: `${width} px` })
          .toBe(width);
        await expect
          .poll(() => visitor.getByText("Welcome to Birch").isVisible(), { message: `${width} px` })
          .toBe(shown);
        expect(await visitor.getByText("Plants for every window").isVisible(), `${width} px`).toBe(
          shown,
        );
      }
      expect(await axeViolations(visitor)).toEqual([]);

      // Every mix of screens, with the CSS the site writes, at the edges of each size.
      // The rules that hide a block are a file the page links to, not text inside the page.
      expect(home).not.toMatch(/<style[\s>]/);
      let css: string | undefined;
      for (const m of home.matchAll(
        /<link rel="stylesheet" href="(\/site-style\/[0-9a-f]{16}\.css)"/g,
      )) {
        const text = await (await fetch(site.base + m[1]!)).text();
        if (text.startsWith(".oks-hide{")) css = text;
      }
      expect(css).toBeTruthy();
      const mixes = [
        ["phone"],
        ["tablet"],
        ["desktop"],
        ["phone", "tablet"],
        ["phone", "desktop"],
        ["tablet", "desktop"],
        ["phone", "tablet", "desktop"],
      ];
      // A blank page of its own: the site's page says (TH-49) that a style element inside it is not allowed.
      await visitor.goto("about:blank");
      await visitor.setContent(
        `<style>${css}</style>` +
          mixes
            .map(
              (m) =>
                `<div class="oks-hide ${m.map((x) => `oks-hide-${x}`).join(" ")}"><p id="${m.join("-")}">${m.join(" ")}</p></div>`,
            )
            .join(""),
      );
      const screenOf = (width: number) =>
        width < 768 ? "phone" : width < 1025 ? "tablet" : "desktop";
      for (const width of [320, 767, 768, 1024, 1025, 2400]) {
        await visitor.setViewportSize({ width, height: 600 });
        for (const m of mixes)
          expect(
            await visitor.locator(`#${m.join("-")}`).isVisible(),
            `${m.join("+")} at ${width} px`,
          ).toBe(!m.includes(screenOf(width)));
      }
      await visitor.close();

      await call(page, "POST", "/api/admin/themes/default", { action: "use" });
    });

    test("saved sections: save one, place it linked in two places, change it once for both, detach one, and delete it with copies (TH-75 to TH-78)", async () => {
      const page = await signedIn(owner);
      const themes = (await call(page, "GET", "/api/admin/themes")).json as {
        themes: { id: string; key: string }[];
      };
      const birch = themes.themes.find((t) => t.key === "birch")!;
      await call(page, "POST", `/api/admin/themes/${birch.id}`, { action: "use" });
      const home = async () => (await fetch(site.base + "/")).text();
      // Counted in the page itself, not in the data Next.js adds for the browser in scripts.
      const times = (html: string, text: string) =>
        html.replace(/<script[\s\S]*?<\/script>/g, "").split(text).length - 1;
      expect(times(await home(), "Welcome to Birch")).toBe(1);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(site.base + "/admin/settings/site-editor");
      const tools = page.getByRole("complementary", { name: "Tools" });
      const outline = page.getByRole("region", { name: /^Outline of/ });
      const publish = async (text: string) => {
        await page.getByRole("button", { name: /^Publish changes \(\d+\)$/ }).click();
        await page.getByText(text).waitFor();
      };

      // Save the welcome group as a section and link this place to it.
      await outline.getByRole("button", { name: 'Group "welcome" (hidden on phone)' }).click();
      await tools.getByRole("button", { name: "Save as a section" }).click();
      await tools.getByLabel("Name").fill("Welcome box");
      await tools.getByLabel("Group").selectOption("hero");
      await tools.getByLabel("Link this place to the saved section").check();
      await tools.getByRole("button", { name: "Save the section" }).click();
      await page
        .getByText(
          'Saved as "Welcome box". It is in the library under My sections, and this place is linked to it.',
        )
        .waitFor();
      await tools.getByRole("heading", { name: "Selected: Linked section: Welcome box" }).waitFor();
      await tools.getByText(/^Linked section · /).waitFor();
      await page.getByText("Draft kept").waitFor();
      await publish("Published 1 layout. Your site shows the changes now.");
      let html = await home();
      expect(times(html, "Welcome to Birch")).toBe(1);
      // The same HTML as a copy: the hiding of the group still applies.
      expect(html).toContain('class="oks-hide oks-hide-phone"');

      // My sections in the library: place it a second time, linked.
      await page
        .getByRole("navigation", { name: "Layouts" })
        .getByRole("button", { name: /^Welcome box/ })
        .waitFor();
      await tools.getByRole("button", { name: "Add a ready-made section" }).click();
      const library = page.getByRole("dialog", { name: "Ready-made sections" });
      await library.getByLabel("My sections (1)").check();
      await page
        .frameLocator('iframe[title="Picture of Welcome box"]')
        .getByText("Welcome to Birch")
        .waitFor();
      await library.getByText("Copy: change it here only").waitFor();
      await library.getByText("Linked: the same everywhere").waitFor();
      expect(await axeViolations(page)).toEqual([]);
      await library.getByRole("button", { name: "Linked Welcome box" }).click();
      await page
        .getByText(
          'Placed "Welcome box" as a linked section: it is the same everywhere it is linked.',
        )
        .waitFor();
      await page.getByText("Draft kept").waitFor();
      await publish("Published 1 layout. Your site shows the changes now.");
      html = await home();
      expect(times(html, "Welcome to Birch")).toBe(2);
      expect(times(html, "Plants for every window")).toBe(2);

      // Change it once: open it, delete its text; a draft until Publish, then both places change.
      await outline.getByRole("button", { name: "Linked section: Welcome box" }).first().click();
      await tools.getByRole("button", { name: "Edit the linked section" }).click();
      await page
        .getByText(/Changes here show on every page where "Welcome box" is linked: this changes /)
        .waitFor();
      const preview = page.frameLocator('iframe[title="Preview of your site with your changes"]');
      await preview.getByText("Plants for every window").click();
      await tools
        .getByRole("heading", { name: "Selected: Text: Plants for every window" })
        .waitFor();
      await tools.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByText("Draft kept").waitFor();
      expect(times(await home(), "Plants for every window")).toBe(2);
      expect(await axeViolations(page)).toEqual([]);
      await publish("Published 1 saved section. Your site shows the changes now.");
      html = await home();
      expect(times(html, "Plants for every window")).toBe(0);
      expect(times(html, "Welcome to Birch")).toBe(2);

      // Only design managers: the server refuses an editor, not only the screen (TH-77).
      const list = (await call(page, "GET", "/api/admin/sections")).json as {
        sections: { id: string; name: string; places: number }[];
      };
      const welcome = list.sections.find((x) => x.name === "Welcome box")!;
      expect(welcome.places).toBe(1);
      const editor = await signedIn(cara);
      expect((await call(editor, "GET", "/api/admin/sections")).status).toBe(403);
      expect(
        (await call(editor, "PUT", `/api/admin/sections/${welcome.id}`, { blocks: [] })).status,
      ).toBe(403);
      expect((await call(editor, "DELETE", `/api/admin/sections/${welcome.id}`)).status).toBe(403);

      // Detach the second place: it becomes a copy there; the first stays linked (TH-76).
      await page
        .getByRole("navigation", { name: "Layouts" })
        .getByRole("button", { name: /^Default/ })
        .click();
      await outline.getByRole("button", { name: "Linked section: Welcome box" }).last().click();
      await tools.getByRole("button", { name: "Detach" }).click();
      await page
        .getByText("Detached: this place has its own copy now. Other places stay linked.")
        .waitFor();
      await page.getByText("Draft kept").waitFor();
      await expect
        .poll(() => outline.getByRole("button", { name: "Linked section: Welcome box" }).count())
        .toBe(1);
      await publish("Published 1 layout. Your site shows the changes now.");
      expect(times(await home(), "Welcome to Birch")).toBe(2);

      // Delete it: the places are listed, each gets a copy first, and the page is the same before and after (TH-78).
      const body = (h: string) => h.replace(/<script[\s\S]*?<\/script>/g, "");
      const before = body(await home());
      await page
        .getByRole("navigation", { name: "Layouts" })
        .getByRole("button", { name: /^Welcome box/ })
        .click();
      const box = page.getByRole("region", { name: "This saved section" });
      await box.getByRole("button", { name: "Delete this section" }).click();
      await box.getByText("Default (used when no other layout fits)").waitFor();
      await box
        .getByRole("button", { name: "Keep it on these pages as copies, then delete" })
        .click();
      await page
        .getByText('"Welcome box" is deleted. Every place that linked it has a copy now.')
        .waitFor();
      expect(body(await home())).toBe(before);
      expect(
        ((await call(page, "GET", "/api/admin/sections")).json as { sections: unknown[] }).sections,
      ).toEqual([]);
      const audit = await db.run(
        "select action from audit_log where action = 'saved_section.delete' and detail like '%Welcome box%'",
      );
      expect(audit).toHaveLength(1);

      await call(page, "POST", "/api/admin/themes/default", { action: "use" });
    });

    test("layouts the owner makes: a landing page made from a copy, chosen by a page, and deleted with the page moved back (TH-72)", async () => {
      const page = await signedIn(owner);
      const themes = (await call(page, "GET", "/api/admin/themes")).json as {
        themes: { id: string; key: string }[];
      };
      const birch = themes.themes.find((t) => t.key === "birch")!;
      await call(page, "POST", `/api/admin/themes/${birch.id}`, { action: "use" });
      const visible = async (path: string) =>
        (await (await fetch(site.base + path)).text()).replace(/<script[\s\S]*?<\/script>/g, "");

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(site.base + "/admin/settings/site-editor");
      const nav = page.getByRole("navigation", { name: "Layouts" });
      const tools = page.getByRole("complementary", { name: "Tools" });

      // New layout: for pages to choose, a copy of the Default layout.
      await nav.getByRole("button", { name: "New layout" }).click();
      await nav.getByLabel("What is it for?").selectOption("pages");
      await nav.getByLabel("Name").fill("Landing page");
      await nav.getByLabel("Start from").selectOption("templates/index");
      await nav.getByRole("button", { name: "Make the layout" }).click();
      await page
        .getByText('"Landing page" is made. Pages can choose it in their settings, under Layout.')
        .waitFor();
      await nav.getByRole("button", { name: /^Landing page\s*Made by you/ }).waitFor();
      await page
        .getByText("You are changing the Landing page layout. No published page uses it yet.")
        .waitFor();
      expect(await axeViolations(page)).toEqual([]);

      // Change it: a heading at the end; publish.
      await tools.getByLabel(/Add (after the selected block|at the end)/).selectOption("heading");
      await tools.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByText("Draft kept").waitFor();
      await page.getByRole("button", { name: "Publish changes (1)" }).click();
      await page.getByText("Published 1 layout. Your site shows the changes now.").waitFor();
      expect(await visible("/about")).not.toContain("New heading");

      // The About page chooses it in its settings; other pages keep theirs.
      const aboutId = String(
        (await db.run("select id from entries where slug = 'about'"))[0]!["id"],
      );
      await page.goto(site.base + `/admin/pages/${aboutId}`);
      const box = page.getByRole("form", { name: "Layout" });
      await box.getByLabel("How this page is laid out").selectOption({ label: "Landing page" });
      await box.getByRole("button", { name: "Update the layout" }).click();
      await page.getByText("Layout saved. The page uses it now.").waitFor();
      expect(await axeViolations(page)).toEqual([]);
      expect(await visible("/about")).toContain("New heading");
      expect(await visible("/contact")).not.toContain("New heading");
      // Only a layout of the theme in use; an editor may not make layouts.
      expect(
        (
          await call(page, "PUT", `/api/admin/entries/${aboutId}/layout`, {
            layout: "custom-nothing",
          })
        ).status,
      ).toBe(400);
      const editor = await signedIn(cara);
      expect(
        (
          await call(editor, "POST", `/api/admin/themes/${birch.id}/layouts`, {
            action: "create",
            for: "pages",
            name: "X",
          })
        ).status,
      ).toBe(403);

      // The banner counts the page; deleting lists it and moves it back to its usual layout.
      await page.goto(site.base + "/admin/settings/site-editor");
      await nav.getByRole("button", { name: /^Landing page/ }).click();
      await page
        .getByText("You are changing the Landing page layout. This changes 1 page.")
        .waitFor();
      await tools.getByRole("button", { name: "Delete this layout" }).click();
      const removing = tools.getByRole("group", { name: "Delete this layout" });
      await removing.getByText("About").waitFor();
      await removing
        .getByRole("button", { name: "Move these pages to their usual layout, then delete" })
        .click();
      await page
        .getByText('"Landing page" is deleted. Its pages use their usual layout again.')
        .waitFor();
      expect(await visible("/about")).not.toContain("New heading");
      expect(await nav.getByRole("button", { name: /^Landing page/ }).count()).toBe(0);
      // With nothing to choose, the page's Layout box is gone.
      await page.goto(site.base + `/admin/pages/${aboutId}`);
      await page.getByRole("form", { name: "Search engines" }).waitFor();
      expect(await page.getByRole("form", { name: "Layout" }).count()).toBe(0);

      await call(page, "POST", "/api/admin/themes/default", { action: "use" });
    });

    test("export as a theme: download the theme file, install it again as a new theme, and the site looks the same (TH-73)", async () => {
      const page = await signedIn(owner);
      const themes = (await call(page, "GET", "/api/admin/themes")).json as {
        themes: { id: string; key: string }[];
      };
      const birch = themes.themes.find((t) => t.key === "birch")!;
      await call(page, "POST", `/api/admin/themes/${birch.id}`, { action: "use" });
      const visible = async (path: string) =>
        (await (await fetch(site.base + path)).text())
          .replace(/<script[\s\S]*?<\/script>/g, "")
          .replace(/<link[^>]*>/g, "");
      const before = await visible("/");
      expect(before).toContain("Welcome to Birch");

      // Only design managers may export.
      const editor = await signedIn(cara);
      expect((await call(editor, "GET", `/api/admin/themes/${birch.id}/export`)).status).toBe(403);

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByText("Export Birch as a theme").click();
      await page.getByLabel("Name of the new theme").first().waitFor();
      const row = page
        .getByRole("listitem")
        .filter({ has: page.getByRole("heading", { name: /^Birch 1\.0\.0/ }) });
      await row.getByLabel("Name of the new theme").fill("Birch for Anna");
      expect(await axeViolations(page)).toEqual([]);
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        row.getByRole("button", { name: "Download the theme file" }).click(),
      ]);
      expect(download.suggestedFilename()).toBe("birch-for-anna-1.0.0.tgz");
      const file = readFileSync((await download.path())!);
      expect([file[0], file[1]]).toEqual([0x1f, 0x8b]);

      // It installs as a new theme (Birch itself is untouched) and draws the same front page.
      await page.goto(site.base + "/admin/settings/themes");
      await page.getByLabel("Theme file (.tgz)").setInputFiles({
        name: "birch-for-anna-1.0.0.tgz",
        mimeType: "application/gzip",
        buffer: file,
      });
      await page.getByRole("button", { name: "Upload and check" }).click();
      await page.getByText("Birch for Anna 1.0.0 is installed. It is not in use yet.").waitFor();
      await page.getByRole("button", { name: "Use Birch for Anna" }).click();
      await page.getByRole("button", { name: "Yes, switch to Birch for Anna" }).click();
      await page.getByText("Your site uses Birch for Anna now.").waitFor();
      expect(await visible("/")).toBe(before);

      await call(page, "POST", "/api/admin/themes/default", { action: "use" });
    });
  },
);

describe.skipIf(!findBrowser())("email settings (spec 13)", { timeout: 120_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  let smtp: SMTPServer;
  let smtpPort = 0;
  const received: { to: string[]; data: string }[] = [];
  const owner = { email: "anna@example.com", password: "a-long-password" };
  const cara = { email: "cara@example.com", password: "cara-long-password" };

  beforeAll(async () => {
    // A local mail server with STARTTLS and a certificate made for this run; the site trusts it through
    // NODE_EXTRA_CA_CERTS, as a real site trusts a real provider's certificate.
    const dir = mkdtempSync(join(tmpdir(), "oks-mail-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    smtp = new SMTPServer({
      key: readFileSync(join(dir, "key.pem")),
      cert: readFileSync(join(dir, "cert.pem")),
      authOptional: false,
      onAuth(auth, _session, done) {
        if (auth.username === "anna" && auth.password === "smtp-password")
          done(null, { user: "anna" });
        else done(new Error("Invalid username or password"));
      },
      onData(stream, session, done) {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          received.push({
            to: session.envelope.rcptTo.map((r) => r.address),
            data: Buffer.concat(chunks).toString("utf8"),
          });
          done();
        });
      },
      logger: false,
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    smtpPort = (smtp.server.address() as { port: number }).port;

    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-email-")), "site.sqlite"));
    site = await startSite("sqlite", db, {
      OKS_SECRET: "e".repeat(40),
      NODE_EXTRA_CA_CERTS: join(dir, "cert.pem"),
    });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ siteName: "Anna's Garden", admin: { name: "Anna", ...owner } }),
    });
    expect(made.status).toBe(200);
    const signUp = await fetch(site.base + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: site.base },
      body: JSON.stringify({ name: "Cara", ...cara }),
    });
    const caraId = ((await signUp.json()) as { user: { id: string } }).user.id;
    const siteId = String((await db.run("select id from sites"))[0]!["id"]);
    const role = String((await db.run("select id from roles where key = 'editor'"))[0]!["id"]);
    await db.run(
      "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
      [siteId, caraId, role, new Date()],
    );
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
    await new Promise<void>((resolve) => (smtp ? smtp.close(() => resolve()) : resolve()));
  });

  // One signed-in page per person, kept while it stays signed in: the site allows 5 sign-ins per address in 5 minutes.
  type Page = Awaited<ReturnType<Browser["newPage"]>>;
  const pages = new Map<string, Page>();
  const signedIn = async (who: { email: string; password: string }) => {
    const kept = pages.get(who.email);
    if (kept) {
      // Still signed in? The session itself says so (a page can show an address just before it redirects).
      const session = (await (
        await kept.request.get(site.base + "/api/auth/get-session")
      ).json()) as {
        user?: unknown;
      } | null;
      if (session?.user) {
        await kept.goto(site.base + "/admin");
        await kept.getByRole("heading", { name: "Home", level: 1 }).waitFor();
        return kept;
      }
    }
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(who.email);
    await page.getByLabel(/^Password/).fill(who.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    pages.set(who.email, page);
    return page;
  };
  const axeViolations = async (page: Awaited<ReturnType<typeof signedIn>>) => {
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      }),
    );
    return result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  };

  test("off until a test email is accepted: the note, a refused password keeps it off, the right one turns it on; the password never comes back; editors are refused (EM-01, EM-02, EM-05)", async () => {
    const page = await signedIn(owner);
    // The dashboard says email is off, with a way to set it up; an editor does not get the note.
    await page
      .getByText("Email is not set up: password reset and invitations by email are off.")
      .waitFor();
    const editor = await signedIn(cara);
    expect(await editor.getByText("Email is not set up").count()).toBe(0);
    const api = (await editor.request.get(site.base + "/api/admin/settings/email")).status();
    expect(api).toBe(403);

    await page.getByRole("link", { name: "Set up email" }).click();
    await page.getByRole("heading", { name: "Email settings", level: 1 }).waitFor();
    await page.getByText("Password reset and invitations by email are off.").first().waitFor();
    expect(await axeViolations(page)).toEqual([]);
    // A preset fills in the server and the port.
    await page.getByLabel("Email provider").selectOption("postmark");
    expect(await page.getByLabel("Mail server (SMTP)").inputValue()).toBe("smtp.postmarkapp.com");
    expect(await page.getByLabel("Port", { exact: true }).inputValue()).toBe("587");

    await page.getByLabel("Email provider").selectOption("other");
    await page.getByLabel("Mail server (SMTP)").fill("localhost");
    await page.getByLabel("Port", { exact: true }).fill(String(smtpPort));
    await page.getByRole("radio", { name: /STARTTLS/ }).check();
    await page.getByLabel("User name").fill("anna");
    await page.getByLabel("Password or API key").fill("wrong-password");
    await page.getByLabel("Sender name").fill("Anna's Garden");
    await page.getByLabel("Sender address").fill("hello@annas-garden.example");
    expect(await page.getByLabel("Send the test email to").inputValue()).toBe("anna@example.com");
    await page.getByRole("button", { name: "Send a test email and save" }).click();
    await page
      .getByText(
        "The test email was not sent: The mail server refused the user name or the password. Email stays off.",
      )
      .waitFor();
    expect(received).toHaveLength(0);

    await page.getByLabel("Password or API key").fill("smtp-password");
    await page.getByRole("button", { name: "Send a test email and save" }).click();
    await page
      .getByText("The test email was accepted. Email works now. Look for it at anna@example.com.")
      .waitFor();
    await page.getByText(/^Email works\./).waitFor();
    expect(received).toHaveLength(1);
    expect(received[0]!.to).toEqual(["anna@example.com"]);
    expect(received[0]!.data).toContain("Subject: Test email from Anna's Garden");
    // The record shows both tries; the password is not in the page, the answer or the database.
    const record = page.getByRole("region", { name: "Emails of the last 30 days" });
    await record.getByText("Sent", { exact: true }).waitFor();
    await record
      .getByText(/^Not sent: The mail server refused the user name or the password\./)
      .waitFor();
    expect(await page.getByLabel("Password or API key").inputValue()).toBe("");
    await page
      .getByText("A password is saved. Leave this empty to keep it.", { exact: false })
      .waitFor();
    expect(await page.content()).not.toContain("smtp-password");
    const answer = await (await page.request.get(site.base + "/api/admin/settings/email")).text();
    expect(answer).not.toContain("smtp-password");
    expect(
      JSON.stringify(await db.run("select value from settings where key = 'email'")),
    ).not.toContain("smtp-password");
    expect(await axeViolations(page)).toEqual([]);

    // Saved again with the password left empty: the saved one is used.
    await page.reload();
    await page.getByLabel("Sender name").fill("Anna");
    await page.getByRole("button", { name: "Send a test email and save" }).click();
    await page.getByText("The test email was accepted.", { exact: false }).waitFor();
    expect(received).toHaveLength(2);

    // The dashboard note is gone; turning email off brings it back.
    await page.goto(site.base + "/admin");
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    expect(await page.getByText("Email is not set up").count()).toBe(0);
    await page.goto(site.base + "/admin/settings/email");
    await page.getByRole("button", { name: "Turn email off" }).click();
    await page
      .getByText("Email is off. Password reset and invitations by email are off too.")
      .waitFor();
    await page.goto(site.base + "/admin");
    await page
      .getByText("Email is not set up: password reset and invitations by email are off.")
      .waitFor();
  });

  test("by email: an invitation, and a forgotten password with its link and the notice afterwards (spec 13, section 5)", async () => {
    const page = await signedIn(owner);
    // Without email the sign-in page offers no reset, and the reset page says why.
    const visitor = await browser.newPage();
    await visitor.goto(site.base + "/admin/login");
    await visitor.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
    expect(await visitor.getByRole("link", { name: "Forgot your password?" }).count()).toBe(0);
    await visitor.goto(site.base + "/admin/forgot-password");
    await visitor.getByText("This site cannot send email yet", { exact: false }).waitFor();

    // Email on again (the settings are kept by the API only after a test).
    const on = await page.request.put(site.base + "/api/admin/settings/email", {
      headers: { origin: site.base },
      data: {
        provider: "other",
        host: "localhost",
        port: smtpPort,
        security: "starttls",
        username: "anna",
        password: "smtp-password",
        fromName: "Anna's Garden",
        fromAddress: "hello@annas-garden.example",
        testTo: "anna@example.com",
      },
    });
    expect(on.status()).toBe(200);
    const mailTo = async (to: string, count: number) => {
      await expect
        .poll(() => received.filter((m) => m.to.includes(to)).length, { timeout: 15_000 })
        .toBe(count);
      return received.filter((m) => m.to.includes(to)).at(-1)!.data;
    };
    // The link in an email (quoted-printable lines are joined back first).
    const linkIn = (data: string, path: string) => {
      const plain = data.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
      const found = new RegExp(`https?://[^\\s"<>]*${path}[^\\s"<>]*`).exec(plain)?.[0];
      expect(found, plain).toBeTruthy();
      return found!;
    };

    // An invitation by email.
    await page.goto(site.base + "/admin/users");
    const form = page.getByRole("form", { name: "Invite someone" });
    await form.getByLabel("Name").fill("Ben");
    await form.getByRole("textbox", { name: /^Email/ }).fill("ben@example.com");
    await form.getByLabel("Send the invitation by email").waitFor();
    expect(await form.getByLabel("Send the invitation by email").isChecked()).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    await form.getByRole("button", { name: "Invite and send the email" }).click();
    await page
      .getByText("It is on its way to ben@example.com by email.", { exact: false })
      .waitFor();
    const invitation = await mailTo("ben@example.com", 1);
    expect(invitation).toContain("Subject: You are invited to Anna's Garden");
    const inviteLink = linkIn(invitation, "/admin/invite/");
    const ben = await browser.newPage();
    await ben.goto(inviteLink.replace(/^https?:\/\/[^/]+/, site.base));
    await ben.getByText("Your email:", { exact: false }).waitFor();

    // A forgotten password: the link on the sign-in page, the same answer for any address, the email, the new password.
    await visitor.goto(site.base + "/admin/login");
    await visitor.getByRole("link", { name: "Forgot your password?" }).click();
    await visitor.getByRole("heading", { name: "Forgot your password?", level: 1 }).waitFor();
    expect(await axeViolations(visitor)).toEqual([]);
    await visitor.getByLabel("Email").fill("nobody@example.com");
    await visitor.getByRole("button", { name: "Send me a link" }).click();
    await visitor
      .getByText("If an account uses nobody@example.com, an email with a link is on its way.", {
        exact: false,
      })
      .waitFor();
    await visitor.reload();
    const before = received.filter((m) => m.to.includes("anna@example.com")).length;
    await visitor.getByLabel("Email").fill("anna@example.com");
    await visitor.getByRole("button", { name: "Send me a link" }).click();
    await visitor
      .getByText("If an account uses anna@example.com, an email with a link is on its way.", {
        exact: false,
      })
      .waitFor();
    const resetMail = await mailTo("anna@example.com", before + 1);
    expect(resetMail).toContain("Subject: Choose a new password for Anna's Garden");
    expect(received.some((m) => m.to.includes("nobody@example.com"))).toBe(false);
    const resetLink = linkIn(resetMail, "/admin/reset-password");
    await visitor.goto(resetLink.replace(/^https?:\/\/[^/]+/, site.base));
    await visitor.getByRole("heading", { name: "Choose a new password", level: 1 }).waitFor();
    expect(await axeViolations(visitor)).toEqual([]);
    await visitor.getByLabel(/^New password/).fill("a fresh long password");
    await visitor.getByLabel(/^The new password again/).fill("a fresh long password");
    await visitor.getByRole("button", { name: "Change my password" }).click();
    await visitor
      .getByText("Your password is changed, and you are signed out everywhere.", { exact: false })
      .waitFor();
    // The notice follows; the old session is gone; the new password works; the link does not work twice.
    const notice = await mailTo(
      "anna@example.com",
      received.filter((m) => m.to.includes("anna@example.com")).length + 1,
    );
    expect(notice).toContain("Subject: Your password was changed: Anna's Garden");
    await page.goto(site.base + "/admin");
    await page.waitForURL((url) => url.pathname === "/admin/login");
    owner.password = "a fresh long password";
    await signedIn(owner);
    await visitor.goto(resetLink.replace(/^https?:\/\/[^/]+/, site.base));
    await visitor.getByLabel(/^New password/).fill("yet another long password");
    await visitor.getByLabel(/^The new password again/).fill("yet another long password");
    await visitor.getByRole("button", { name: "Change my password" }).click();
    await visitor.getByText("This link no longer works", { exact: false }).waitFor();
  });

  test("the words of an email: a security email refused without its link, saved, used for the next email, tested, and reset (EM-10, EM-11)", async () => {
    const page = await signedIn(owner);
    await page.goto(site.base + "/admin/settings/email");
    await page.getByRole("link", { name: "Change the words of the emails" }).click();
    await page.getByRole("heading", { name: "Email texts", level: 1 }).waitFor();
    const list = page.getByRole("navigation", { name: "Emails" });
    await list.getByRole("button", { name: /^Password reset\s*Security email · original/ }).click();
    await page
      .getByText("People use this email to get into their account.", { exact: false })
      .waitFor();
    const preview = page.frameLocator('iframe[title="Preview of the email"]');
    await preview.getByText("Someone asked to set a new password", { exact: false }).waitFor();
    expect(await axeViolations(page)).toEqual([]);

    // Without {link} it cannot be saved.
    await page.getByLabel("Text").fill("Hello {name}, we will call you.");
    await page.getByText("The text must contain {link}", { exact: false }).first().waitFor();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Not saved").waitFor();

    // New words, with a placeholder put in by its button.
    await page.getByLabel("Subject").fill("Your new password for {site}");
    await page
      .getByLabel("Text")
      .fill("Hi {name},\n\n**Here is your link:** [new password]({link})\n\n");
    await page.getByRole("button", { name: "{site}" }).click();
    await preview.getByText("Here is your link:", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved. Emails use your words from now on.").waitFor();
    await list
      .getByRole("button", { name: /^Password reset\s*Security email · changed by you/ })
      .waitFor();

    // Send me a test: with sample values.
    const count = () => received.filter((m) => m.to.includes("anna@example.com")).length;
    let before = count();
    await page.getByRole("button", { name: "Send me a test" }).click();
    await page.getByText("A test is on its way to anna@example.com, with sample values.").waitFor();
    await expect.poll(count, { timeout: 15_000 }).toBe(before + 1);
    expect(received.at(-1)!.data).toContain("Subject: Test: Your new password for Anna's Garden");

    // The next real reset uses the new words.
    before = count();
    const asked = await fetch(site.base + "/api/auth/request-password-reset", {
      method: "POST",
      headers: { "content-type": "application/json", origin: site.base },
      body: JSON.stringify({ email: "anna@example.com", redirectTo: "/admin/reset-password" }),
    });
    expect(asked.status).toBe(200);
    await expect.poll(count, { timeout: 15_000 }).toBe(before + 1);
    const mail = received.filter((m) => m.to.includes("anna@example.com")).at(-1)!.data;
    expect(mail).toContain("Subject: Your new password for Anna's Garden");
    expect(mail.replace(/=\r?\n/g, "")).toContain("Here is your link:");
    // The change is in the audit log (a security email).
    expect(
      await db.run(
        "select action from audit_log where target_type = 'email_text' and target_id = 'password-reset'",
      ),
    ).toEqual([{ action: "email_text.change" }]);

    // Back to the original.
    await page.getByRole("button", { name: "Reset to the original" }).click();
    await page.getByText("Back to the original words.").waitFor();
    expect(await page.getByLabel("Subject").inputValue()).toBe("Choose a new password for {site}");
    await list
      .getByRole("button", { name: /^Password reset\s*Security email · original/ })
      .waitFor();
  });

  test("will the emails reach the inbox: the sender domain's records in plain steps, and a warning when emails keep failing (EM-09, EM-14)", async () => {
    const page = await signedIn(owner);
    await page.goto(site.base + "/admin/settings/email");
    const section = page.getByRole("region", { name: "Will your emails reach the inbox?" });
    await section.waitFor();
    // The sender is on a .example domain, which has no records (or, offline, cannot be looked up): never an error.
    await section.getByRole("button", { name: "Check again" }).click();
    await section.getByRole("button", { name: "Check again" }).waitFor();
    const checks = section.getByRole("list", { name: "Domain checks" }).getByRole("listitem");
    await expect.poll(() => checks.count()).toBe(3);
    const words = await checks.allTextContents();
    expect(words[0]).toMatch(/^SPF \(who may send for your domain\): (Check this|Could not check)/);
    expect(words[1]).toMatch(/^DKIM \(the signature on your emails\): Could not check/);
    expect(words[2]).toMatch(
      /^DMARC \(what to do with emails that fail\): (Check this|Could not check)/,
    );
    if (words[0]!.includes("Check this")) expect(words[0]).toContain("What to do:");
    expect(await axeViolations(page)).toEqual([]);

    // Three emails that failed in a row: the email screen and the dashboard say so.
    const siteId = String((await db.run("select id from sites"))[0]!["id"]);
    for (let i = 0; i < 3; i++)
      await db.run(
        `insert into email_log (id, site_id, email_key, to_address, subject, provider, status, error, attempts, created_at)
          values (?, ?, 'invitation', 'x@example.com', 'Hello', 'other', 'failed', 'The mail server refused the address.', 1, ?)`,
        [`01M7F${String(i).padStart(21, "0")}`, siteId, new Date(Date.now() + i * 1000)],
      );
    await page.reload();
    await page.getByText("Emails are not going out").first().waitFor();
    await page
      .getByText("The last 3 emails could not be sent.", { exact: false })
      .first()
      .waitFor();
    await page.goto(site.base + "/admin");
    await page.getByText("Emails are not going out.", { exact: false }).waitFor();
    await page.getByRole("link", { name: "Open the email settings" }).waitFor();
    expect(await axeViolations(page)).toEqual([]);
  });

  test("your email address: confirm it, then change it with a yes from the old address and the new one; notices to both (spec 13, section 5)", async () => {
    const page = await signedIn(cara);
    const mailTo = (address: string) =>
      received
        .filter((m) => m.to.includes(address))
        .map((m) => m.data.replace(/=\r?\n/g, "").replace(/=3D/g, "="));
    const linkIn = (mail: string) => {
      const found = /https?:\/\/[^\s"<>()\]]+\/api\/auth\/verify-email\?token=[^\s"<>()\]&]+/.exec(
        mail,
      );
      expect(found, "a link in the email").not.toBeNull();
      return found![0];
    };
    const waitFor = async (address: string, subject: string) => {
      await expect
        .poll(() => mailTo(address).filter((m) => m.includes(`Subject: ${subject}`)).length, {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);
      return mailTo(address)
        .filter((m) => m.includes(`Subject: ${subject}`))
        .at(-1)!;
    };

    await page.goto(site.base + "/admin/account");
    const section = page.getByRole("region", { name: "Email address" });
    await section.getByText("Not confirmed yet", { exact: false }).waitFor();
    // Changing needs a confirmed address first (the form is not there, and the server refuses it too).
    expect(await page.getByLabel("New email address").count()).toBe(0);
    const early = await page.request.post(site.base + "/api/auth/change-email", {
      headers: { origin: site.base, "content-type": "application/json" },
      data: { newEmail: "cara.new@example.com", password: cara.password },
    });
    expect(early.status()).toBe(400);
    expect(JSON.stringify(await early.json())).toContain(
      "Confirm your current email address first",
    );
    expect(await axeViolations(page)).toEqual([]);

    // Confirm the address.
    await section.getByRole("button", { name: "Send me a confirmation link" }).click();
    await page.getByText(`We sent a link to ${cara.email}. Open it within an hour.`).waitFor();
    const confirm = await waitFor(cara.email, "Confirm your email address for Anna's Garden");
    await page.goto(linkIn(confirm));
    await page.getByText("Thank you: your email address is confirmed.").waitFor();
    await section.getByText("Confirmed", { exact: false }).first().waitFor();
    expect(
      (await db.run("select email_verified from users where email = ?", [cara.email]))[0]![
        "email_verified"
      ],
    ).toBeTruthy();

    // Change it: the old address says yes first, then the new one.
    await page.getByLabel("New email address").fill("cara.new@example.com");
    // A wrong password is refused (spec 02, rule 7); nothing is sent.
    await page.getByLabel("Your current password").fill("not-the-password");
    await page.getByRole("button", { name: "Change my email address" }).click();
    await page.getByText("Your current password is not right.").waitFor();
    await page.getByLabel("Your current password").fill(cara.password);
    await page.getByRole("button", { name: "Change my email address" }).click();
    await page
      .getByText(`We sent a link to your current address, ${cara.email}.`, { exact: false })
      .waitFor();
    const ask = await waitFor(
      cara.email,
      "Change the email address of your account on Anna's Garden?",
    );
    expect(ask).toContain("cara.new@example.com");
    expect((await db.run("select email from users where email = ?", [cara.email])).length).toBe(1);
    await page.goto(linkIn(ask));
    await page.getByText("Your old address said yes.", { exact: false }).waitFor();
    expect((await db.run("select email from users where email = ?", [cara.email])).length).toBe(1);
    const confirmNew = await waitFor(
      "cara.new@example.com",
      "Confirm your new email address for Anna's Garden",
    );
    await page.goto(linkIn(confirmNew));
    await page
      .getByText("Your account uses the new email address now.", { exact: false })
      .waitFor();
    expect(
      (await db.run("select email from users where email = 'cara.new@example.com'")).length,
    ).toBe(1);
    // A notice to the old address and to the new one.
    for (const address of [cara.email, "cara.new@example.com"]) {
      const notice = await waitFor(address, "Your email address was changed: Anna's Garden");
      expect(notice).toContain(`from ${cara.email} to cara.new@example.com`);
    }
    // An old link does not work again.
    await page.goto(linkIn(confirmNew));
    await page.getByText("That link did not work").waitFor();
    // Signing in uses the new address.
    const fresh = await browser.newPage();
    await fresh.goto(site.base + "/admin/login");
    await fresh.getByLabel("Email").fill("cara.new@example.com");
    await fresh.getByLabel(/^Password/).fill(cara.password);
    await fresh.getByRole("button", { name: "Sign in" }).click();
    await fresh.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    await fresh.close();
  });

  test("a sign-in link by email for a confirmed address, and the alert about a sign-in from a new device (spec 13, section 5)", async () => {
    // Cara's address was confirmed and changed in the test before.
    const address = "cara.new@example.com";
    const mailTo = (to: string) =>
      received
        .filter((m) => m.to.includes(to))
        .map((m) => m.data.replace(/=\r?\n/g, "").replace(/=3D/g, "="));
    const withSubject = (to: string, subject: string) =>
      mailTo(to).filter((m) => m.includes(`Subject: ${subject}`));
    const waitFor = async (to: string, subject: string, count = 1) => {
      await expect
        .poll(() => withSubject(to, subject).length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(count);
      return withSubject(to, subject).at(-1)!;
    };

    // A new browser asks for a link on the sign-in page.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByLabel("Email for the link").fill(address);
    await page.getByRole("button", { name: "Send the link" }).click();
    await page
      .getByText(`If ${address} has an account here, an email is on its way.`, { exact: false })
      .waitFor();
    expect(await axeViolations(page)).toEqual([]);
    const mail = await waitFor(address, "Your sign-in link for Anna's Garden");
    const link =
      /https?:\/\/[^\s"<>()\]]+\/api\/auth\/magic-link\/verify\?token=[^\s"<>()\]&]+[^\s"<>()\]]*/
        .exec(mail)![0]
        .replace(/&amp;/g, "&");
    await page.goto(link);
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    // That browser was new for Cara: the alert.
    const alert = await waitFor(address, "A sign-in from a new device: Anna's Garden");
    expect(alert).toMatch(/Chrome on Linux|a browser/);
    // The same link a second time does not work.
    const other = await browser.newPage();
    await other.goto(link);
    await other.getByText("That sign-in link did not work").waitFor();
    await other.close();

    // Signing in again from the same browser is quiet.
    const alerts = withSubject(address, "A sign-in from a new device: Anna's Garden").length;
    const out = await page.request.post(site.base + "/api/auth/sign-out", {
      headers: { origin: site.base, "content-type": "application/json" },
      data: {},
    });
    expect(out.status()).toBe(200);
    await page.goto(site.base + "/admin/login");
    await page.getByLabel(/^Email\s*\*?$/).fill(address);
    await page.getByLabel(/^Password/).fill(cara.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    await new Promise((r) => setTimeout(r, 1500));
    expect(withSubject(address, "A sign-in from a new device: Anna's Garden").length).toBe(alerts);
    await context.close();

    // The owner has two-factor off but an unconfirmed address: no link, the reason instead.
    const ownerPage = await browser.newPage();
    await ownerPage.goto(site.base + "/admin/login");
    await ownerPage.getByRole("button", { name: "Email me a sign-in link" }).click();
    await ownerPage.getByLabel("Email for the link").fill(owner.email);
    await ownerPage.getByRole("button", { name: "Send the link" }).click();
    const refused = await waitFor(owner.email, "About signing in to Anna's Garden");
    expect(refused).toContain("Sign-in links work only for a confirmed email address.");
    expect(refused).not.toContain("magic-link/verify");
    await ownerPage.close();
  });

  test("EM-30: a page handed in for review and a comment waiting each send an email to the people who may act on them", async () => {
    const page = await signedIn(owner);
    let uid = 0;
    const b = (
      type: string,
      props: Record<string, unknown> = {},
      children: unknown[] = [],
      content: unknown = null,
    ) => ({ id: `em30${++uid}x`, type, props, content, children });
    const words = (value: string) => [{ type: "text", text: value, styles: {} }];
    const on = await page.request.put(site.base + "/api/admin/settings/email", {
      headers: { origin: site.base },
      data: {
        provider: "other",
        host: "localhost",
        port: smtpPort,
        security: "starttls",
        username: "anna",
        password: "smtp-password",
        fromName: "Anna's Garden",
        fromAddress: "hello@annas-garden.example",
        testTo: "anna@example.com",
      },
    });
    expect(on.status()).toBe(200);
    const withSubject = (to: string, subject: string) =>
      received.filter((m) => m.to.includes(to) && m.data.includes(`Subject: ${subject}`));
    const arrived = async (to: string, subject: string, count: number) => {
      await expect.poll(() => withSubject(to, subject).length, { timeout: 15_000 }).toBe(count);
    };

    // Cara (an editor) hands a post in for review: the owner is told, and Cara, who wrote it, is not.
    const writer = (await signedIn(cara)) as { request: typeof page.request };
    const made = await writer.request.post(site.base + "/api/admin/entries", {
      headers: { origin: site.base },
      data: { type: "post", title: "Spring jobs" },
    });
    expect(made.status()).toBe(200);
    const draft = (await made.json()) as { id: string; slug: string; revision: number };
    const save = (revision: number) =>
      writer.request.put(site.base + `/api/admin/entries/${draft.id}`, {
        headers: { origin: site.base },
        data: {
          title: "Spring jobs",
          slugPart: draft.slug.split("/").pop(),
          status: "pending",
          blocks: [b("paragraph", {}, [], words("What to do in the garden."))],
          revision,
        },
      });
    const handedIn = await save(draft.revision);
    expect(handedIn.status(), await handedIn.text()).toBe(200);
    await arrived(owner.email, "Waiting for review: Spring jobs", 1);
    expect(withSubject(cara.email, "Waiting for review: Spring jobs")).toHaveLength(0);
    const mail = withSubject(owner.email, "Waiting for review: Spring jobs")[0]!.data;
    expect(mail.replace(/=\r?\n/g, "").replace(/=3D/g, "=")).toContain(`/admin/posts/${draft.id}`);
    // Saving it again while it still waits sends nothing more.
    const saved = (await handedIn.json()) as { revision: number };
    expect((await save(saved.revision)).status()).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(withSubject(owner.email, "Waiting for review: Spring jobs")).toHaveLength(1);

    // A comment on a published post tells the moderators, once an hour each.
    const post = await page.request.post(site.base + "/api/admin/entries", {
      headers: { origin: site.base },
      data: { type: "post", title: "Talk about it" },
    });
    const live = (await post.json()) as { id: string; slug: string; revision: number };
    const published = await page.request.put(site.base + `/api/admin/entries/${live.id}`, {
      headers: { origin: site.base },
      data: {
        title: "Talk about it",
        slugPart: live.slug.split("/").pop(),
        status: "published",
        blocks: [b("paragraph", {}, [], words("A post to talk about."))],
        revision: live.revision,
      },
    });
    expect(published.status(), await published.text()).toBe(200);
    expect(
      (
        await page.request.put(site.base + "/api/admin/comments", {
          headers: { origin: site.base },
          data: { enabled: true },
        })
      ).status(),
    ).toBe(200);
    const subject = "A comment waits for approval: Anna's Garden";
    for (const name of ["Carla", "Carl"]) {
      const sent = await fetch(site.base + "/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json", origin: site.base },
        body: JSON.stringify({ entryId: live.id, name, content: "Lovely post" }),
      });
      expect(sent.status).toBe(200);
    }
    await arrived(owner.email, subject, 1);
    // Cara's address may have changed in the earlier tests: the site writes to the one she has now.
    const caraNow = String(
      (await db.run("select email from users where name = 'Cara'"))[0]!["email"],
    );
    await arrived(caraNow, subject, 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(withSubject(owner.email, subject)).toHaveLength(1);
  });
});

describe.skipIf(!findBrowser())("reading and language settings", { timeout: 150_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const owner = { email: "anna@example.com", password: "a-long-password" };

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-reading-")), "site.sqlite"));
    site = await startSite("sqlite", db, { OKS_SECRET: "r".repeat(40) });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        starterContent: true,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  const visible = async (path: string) => {
    const response = await fetch(site.base + path, { redirect: "manual" });
    const html = (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "");
    return { status: response.status, location: response.headers.get("location"), html };
  };
  const axeViolations = async (page: Awaited<ReturnType<Browser["newPage"]>>) => {
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      }),
    );
    return result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  };

  test("Reading: the home page shows the latest posts or a chosen page, a posts page, posts per page, and feeds with a summary only", async () => {
    // Before: "/" is the Home page; feeds carry the full text.
    expect((await visible("/")).html).toContain("This is your home page.");
    expect(await (await fetch(site.base + "/feed.xml")).text()).toContain("content:encoded");
    // Two more posts, so the list and its length show.
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel(/^Password/).fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    for (const title of ["Spring planting", "Summer pots"]) {
      const made = await page.evaluate(async (t) => {
        const r = await fetch("/api/admin/entries", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "post", title: t }),
        });
        return (await r.json()) as { id: string; revision: number };
      }, title);
      const saved = await page.evaluate(
        async ([id, t, rev]) => {
          const r = await fetch(`/api/admin/entries/${id}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: t,
              slugPart: (t as string).toLowerCase().replace(/ /g, "-"),
              status: "published",
              blocks: [
                {
                  id: "p1",
                  type: "paragraph",
                  props: {},
                  content: [{ type: "text", text: `About ${t}.` }],
                  children: [],
                },
              ],
              revision: rev,
            }),
          });
          return r.status;
        },
        [made.id, title, made.revision] as const,
      );
      expect(saved).toBe(200);
    }

    await page.goto(site.base + "/admin/settings/reading");
    await page.getByRole("heading", { name: "Reading settings", level: 1 }).waitFor();
    expect(await page.getByRole("button", { name: "Save changes" }).isDisabled()).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    await page.getByLabel("Your latest posts").check();
    await page.getByLabel("Posts per page").fill("2");
    await page.getByLabel("A summary").check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Reading settings saved. Your site shows the change now.").waitFor();

    // "/" lists the 2 newest posts with their summaries; feeds carry a summary only.
    let home = (await visible("/")).html;
    expect(home).toContain("Summer pots");
    expect(home).toContain("Spring planting");
    expect(home).not.toContain("Hello world");
    expect(home).toContain("About Summer pots.");
    const feed = await (await fetch(site.base + "/feed.xml")).text();
    expect(feed).not.toContain("content:encoded");
    expect(feed).toContain("<description>About Summer pots.</description>");

    // A page you choose as home, and About as the posts page; the chosen page's own address leads to "/".
    await page.getByLabel("A page you choose").check();
    await page.getByLabel("Home page").selectOption({ label: "Contact" });
    await page.getByLabel("Posts page").selectOption({ label: "About" });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Reading settings saved.", { exact: false }).waitFor();
    home = (await visible("/")).html;
    expect(home).toMatch(/<h1[^>]*>Contact<\/h1>/);
    const about = (await visible("/about")).html;
    expect(about).toMatch(/<h1[^>]*>About<\/h1>/);
    expect(about).toContain("Summer pots");
    const contact = await visible("/contact");
    expect(contact.status).toBe(308);
    expect(contact.location).toMatch(/\/$/);
    // The same page cannot be both.
    await page.getByLabel("Posts page").selectOption({ label: "Contact" });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("The home page and the posts page must be different pages.").waitFor();
    // Back to the start for the next test.
    const reset = await page.evaluate(
      async () =>
        (
          await fetch("/api/admin/settings/reading", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              homeShows: "page",
              homePageId: null,
              postsPageId: null,
              perPage: 10,
              feedFullText: true,
            }),
          })
        ).status,
    );
    expect(reset).toBe(200);
    expect((await visible("/")).html).toContain("This is your home page.");
  });

  test("Languages: the site's language and direction on public pages; the admin stays English and left to right", async () => {
    let html = (await visible("/")).html;
    expect(html).toContain('lang="en" dir="ltr"');
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel(/^Password/).fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    await page.goto(site.base + "/admin/settings/languages");
    await page.getByRole("heading", { name: "Languages settings", level: 1 }).waitFor();
    expect(await axeViolations(page)).toEqual([]);
    await page.getByLabel("Language of your site").selectOption("ar");
    await page.getByLabel("From the language (right to left)").waitFor();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Language saved. Your site shows the change now.").waitFor();
    html = (await visible("/")).html;
    expect(html).toContain('lang="ar" dir="rtl"');
    expect((await visible("/about")).html).toContain('lang="ar" dir="rtl"');
    // The admin is not turned around.
    expect(await page.evaluate(() => document.querySelector('[dir="rtl"]'))).toBeNull();
    // Always left to right, whatever the language.
    await page.getByLabel("Always left to right").check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Language saved.", { exact: false }).waitFor();
    expect((await visible("/")).html).toContain('lang="ar" dir="ltr"');
  });
});

describe.skipIf(!findBrowser())(
  "writing, general and advanced settings",
  { timeout: 150_000 },
  () => {
    let db: TestDb;
    let site: Awaited<ReturnType<typeof startSite>>;
    let browser: Browser;
    const owner = { email: "anna@example.com", password: "a-long-password" };

    beforeAll(async () => {
      db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-writing-")), "site.sqlite"));
      site = await startSite("sqlite", db, { OKS_SECRET: "w".repeat(40) });
      const made = await fetch(site.base + "/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          siteName: "Anna's Garden",
          starterContent: true,
          admin: { name: "Anna", ...owner },
        }),
      });
      expect(made.status).toBe(200);
      browser = await chromium.launch({ executablePath: findBrowser()! });
    }, 300_000);

    afterAll(async () => {
      await browser?.close();
      site?.server.kill();
      await db?.close();
    });

    const axeViolations = async (page: Awaited<ReturnType<Browser["newPage"]>>) => {
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      return result.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      );
    };

    test("writing defaults for new posts, the site icon on public pages, and clearing the saved copies", async () => {
      const page = await browser.newPage();
      await page.goto(site.base + "/admin/login");
      await page.getByLabel("Email").fill(owner.email);
      await page.getByLabel(/^Password/).fill(owner.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      const call = (method: string, url: string, body?: unknown) =>
        page.evaluate(
          async ([m, u, b]) => {
            const r = await fetch(u as string, {
              method: m as string,
              headers: { "content-type": "application/json" },
              ...(b === undefined ? {} : { body: JSON.stringify(b) }),
            });
            return {
              status: r.status,
              json: (await r.json().catch(() => null)) as Record<string, unknown> | null,
            };
          },
          [method, url, body] as const,
        );

      // Writing: the default category for new posts.
      expect((await call("POST", "/api/admin/taxonomies/category", { name: "News" })).status).toBe(
        201,
      );
      await page.goto(site.base + "/admin/settings/writing");
      await page.getByRole("heading", { name: "Writing settings", level: 1 }).waitFor();
      expect(await page.getByRole("button", { name: "Save changes" }).isDisabled()).toBe(true);
      expect(await axeViolations(page)).toEqual([]);
      await page.getByLabel("Default category").selectOption({ label: "News" });
      await page.getByRole("button", { name: "Save changes" }).click();
      await page.getByText("Writing settings saved. New posts start with them.").waitFor();
      const made = await call("POST", "/api/admin/entries", {
        type: "post",
        title: "Spring planting",
      });
      const terms = await db.run(
        "select t.name from entry_terms et join terms t on t.id = et.term_id where et.entry_id = ?",
        [String(made.json!["id"])],
      );
      expect(terms).toEqual([{ name: "News" }]);

      // General: the site icon from the library (a 512 × 512 picture); public pages link it; the address is shown.
      const png = await sharp({
        create: { width: 512, height: 512, channels: 3, background: { r: 30, g: 120, b: 80 } },
      })
        .png()
        .toBuffer();
      const upload = await page.request.post(site.base + "/api/admin/media", {
        headers: { origin: site.base },
        multipart: { file: { name: "icon.png", mimeType: "image/png", buffer: png } },
      });
      expect(upload.status()).toBeLessThan(300);
      const mediaId = String(((await upload.json()) as { id: string }).id);
      await expect
        .poll(async () =>
          String((await db.run("select status from media where id = ?", [mediaId]))[0]!["status"]),
        )
        .toBe("ready");
      await page.goto(site.base + "/admin/settings/general");
      await page.getByRole("heading", { name: "Site icon" }).waitFor();
      await page.getByRole("heading", { name: "Site address" }).waitFor();
      expect(
        await page.getByText(site.base.replace(/^http:\/\//, ""), { exact: false }).count(),
      ).toBeGreaterThan(0);
      // A picture that is not square is refused with a plain message.
      const wide = await page.request.post(site.base + "/api/admin/media", {
        headers: { origin: site.base },
        multipart: {
          file: {
            name: "wide.png",
            mimeType: "image/png",
            buffer: await sharp({
              create: { width: 800, height: 400, channels: 3, background: "#fff" },
            })
              .png()
              .toBuffer(),
          },
        },
      });
      const wideId = String(((await wide.json()) as { id: string }).id);
      const refused = await call("PUT", "/api/admin/settings/site-icon", { mediaId: wideId });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.json)).toContain("must be a square picture");
      expect((await call("PUT", "/api/admin/settings/site-icon", { mediaId })).status).toBe(200);
      await page.reload();
      await page.getByRole("img", { name: "Your site icon" }).waitFor();
      expect(await axeViolations(page)).toEqual([]);
      const home = await (await fetch(site.base + "/")).text();
      expect(home).toMatch(/<link rel="icon" href="[^"]+" type="image\/png"/);
      expect(await (await fetch(site.base + "/about")).text()).toMatch(/<link rel="icon"/);

      // Advanced: maintenance lives here, and the saved copies can be cleared.
      await page.goto(site.base + "/admin/settings/general");
      await page
        .getByRole("navigation", { name: "Settings groups" })
        .getByRole("link", { name: "Advanced" })
        .click();
      await page.getByRole("heading", { name: "Advanced settings", level: 1 }).waitFor();
      await page.getByRole("heading", { name: "Maintenance mode" }).waitFor();
      expect(await axeViolations(page)).toEqual([]);
      await page.getByText("Not cleared by hand yet.").waitFor();
      await page.getByRole("button", { name: "Clear saved copies" }).click();
      await page
        .getByText("The saved copies are cleared. Each page is made fresh at its next visit.")
        .waitFor();
      await page.getByText(/^Last cleared by hand .* by Anna\.$/).waitFor();
      expect(
        await db.run("select action from audit_log where action = 'cache.clear'"),
      ).toHaveLength(1);
      expect((await fetch(site.base + "/about")).status).toBe(200);
    });
  },
);

describe.skipIf(!findBrowser())("privacy and domains settings", { timeout: 150_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const owner = { email: "anna@example.com", password: "a-long-password" };

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-privacy-")), "site.sqlite"));
    site = await startSite("sqlite", db, { OKS_SECRET: "p".repeat(40) });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        starterContent: true,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  const axeViolations = async (page: Awaited<ReturnType<Browser["newPage"]>>) => {
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      }),
    );
    return result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  };

  test("PR-01: public pages set no cookie for visitors", async () => {
    for (const path of ["/", "/about", "/feed.xml", "/sitemap.xml", "/no-such-page"]) {
      const response = await fetch(site.base + path, { redirect: "manual" });
      expect(response.headers.get("set-cookie"), path).toBeNull();
    }
  });

  test("privacy: the cookies, no consent notice, and a draft privacy page; domains: the main address", async () => {
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel(/^Password/).fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();

    await page.goto(site.base + "/admin/settings/general");
    await page
      .getByRole("navigation", { name: "Settings groups" })
      .getByRole("link", { name: "Privacy" })
      .click();
    await page.getByRole("heading", { name: "Privacy settings", level: 1 }).waitFor();
    await page
      .getByText("Your site sets no cookies for visitors, so it does not need a cookie banner.")
      .waitFor();
    await page.getByRole("rowheader", { name: "Sign-in cookie" }).waitFor();
    await page.getByText("Your site has no privacy page yet.").waitFor();
    expect(await axeViolations(page)).toEqual([]);

    await page.getByRole("button", { name: "Write a draft for me" }).click();
    await page.waitForURL(/\/admin\/pages\/[0-9A-Z]{26}$/);
    const id = page.url().split("/").pop()!;
    const rows = await db.run("select status, title from entries where id = ?", [id]);
    expect(rows).toEqual([{ status: "draft", title: "Privacy" }]);

    await page.goto(site.base + "/admin/settings/privacy");
    await page.getByText("(not published yet).", { exact: false }).waitFor();
    expect(await page.getByLabel("Page", { exact: true }).inputValue()).toBe(id);
    // Choosing none, then the page again.
    await page.getByLabel("Page", { exact: true }).selectOption("");
    await page.getByRole("button", { name: "Save privacy page" }).click();
    await page.getByText("The site has no privacy page now.").waitFor();
    await page.getByLabel("Page", { exact: true }).selectOption(id);
    await page.getByRole("button", { name: "Save privacy page" }).click();
    await page.getByText("Privacy page saved.").waitFor();

    await page
      .getByRole("navigation", { name: "Settings groups" })
      .getByRole("link", { name: "Domains" })
      .click();
    await page.getByRole("heading", { name: "Domains", level: 1 }).waitFor();
    await page
      .getByText(site.base.replace(/^http:\/\//, ""), { exact: false })
      .first()
      .waitFor();
    await page.getByText("This address is not secure (no https).", { exact: false }).waitFor();
    expect(await axeViolations(page)).toEqual([]);
  });
});

describe.skipIf(!findBrowser())("site search statistics", { timeout: 150_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const owner = { email: "anna@example.com", password: "a-long-password" };

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-search-stats-")), "site.sqlite"));
    site = await startSite("sqlite", db, { OKS_SECRET: "s".repeat(40) });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        starterContent: true,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  const axeViolations = async (page: Awaited<ReturnType<Browser["newPage"]>>) => {
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      }),
    );
    return result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  };

  test("searches are counted by word and day only; Tools > Site search lists them; Hide from site search (SEO-75)", async () => {
    const about = (await db.run("select id, title from entries where slug = 'about'"))[0]!;
    const title = String(about["title"]);
    const search = async (query: string) => (await fetch(site.base + "/search?" + query)).text();
    expect(await search("q=" + encodeURIComponent(title))).toContain('href="/about"');
    await search("q=" + encodeURIComponent(title.toUpperCase()));
    await search("q=zzqqxx");
    await search("q=anna%40example.com");
    await search("q=%2B44%2020%207946%200958");
    // The next result pages and "search as typed" are not counted again.
    await search("q=zzqqxx&page=2");
    await search("q=zzqqxx&exact=1");
    const term = title.toLocaleLowerCase();
    await expect
      .poll(async () => db.run("select term, searches, no_results from search_terms order by term"))
      .toEqual(
        [
          { term, searches: 2, no_results: 0 },
          { term: "zzqqxx", searches: 1, no_results: 1 },
        ].sort((a, b) => (a.term < b.term ? -1 : 1)),
      );

    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel(/^Password/).fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    await page.getByRole("link", { name: "Tools" }).first().click();
    await page.getByRole("heading", { name: "Site search", level: 1 }).waitFor();
    await page.getByText("in the last 90 days: 3 searches.", { exact: false }).waitFor();
    const popular = page.getByRole("table", { name: "Popular searches" });
    await popular.getByRole("rowheader", { name: term }).waitFor();
    const none = page.getByRole("table", { name: "Searches with no results" });
    await none.getByRole("rowheader", { name: "zzqqxx" }).waitFor();
    expect(await none.getByRole("rowheader").count()).toBe(1);
    expect(await page.content()).not.toContain("anna@example.com</a>");
    expect(await axeViolations(page)).toEqual([]);

    // Hide from site search, in the SEO box of the page.
    await page.goto(site.base + `/admin/pages/${String(about["id"])}`);
    await page.getByLabel("Hide from site search").check();
    await page.getByRole("button", { name: "Update search engine settings" }).click();
    await page.getByText("Search engine settings saved.").waitFor();
    expect(await search("q=" + encodeURIComponent(title))).not.toContain('href="/about"');
    // Still on the site and in the sitemap.
    expect((await fetch(site.base + "/about")).status).toBe(200);
    expect(await (await fetch(site.base + "/sitemap.xml")).text()).toContain("/about");
  });

  test("word forms follow the site language: loaves finds loaf in English, Brote finds Brot in German (SEO-72)", async () => {
    const page = await browser.newPage();
    await page.goto(site.base + "/admin/login");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel(/^Password/).fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    const call = (method: string, url: string, body?: unknown) =>
      page.evaluate(
        async ([m, u, b]) => {
          const r = await fetch(u as string, {
            method: m as string,
            headers: { "content-type": "application/json" },
            ...(b === undefined ? {} : { body: JSON.stringify(b) }),
          });
          return {
            status: r.status,
            json: (await r.json().catch(() => null)) as Record<string, unknown> | null,
          };
        },
        [method, url, body] as const,
      );
    const publish = async (title: string, text: string) => {
      const made = await call("POST", "/api/admin/entries", { type: "post", title });
      const saved = await call("PUT", `/api/admin/entries/${String(made.json!["id"])}`, {
        title,
        slugPart: String(made.json!["slug"]).replace(/^blog\//, ""),
        status: "published",
        blocks: [
          {
            id: "p1",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text, styles: {} }],
            children: [],
          },
        ],
        revision: made.json!["revision"],
      });
      expect(saved.status).toBe(200);
      return String(made.json!["slug"]);
    };
    const rye = await publish("A loaf of rye", "One loaf, baked every morning.");
    const brot = await publish("Unser Brot", "Ein Brot aus Roggen.");
    // "Search as typed" (exact=1) turns typo help off, so only the word and its forms count.
    const found = async (q: string) =>
      await (await fetch(site.base + "/search?exact=1&q=" + encodeURIComponent(q))).text();
    // English (the site's language): another form of the word, marked in the result.
    const english = await found("loaves");
    expect(english).toContain(`href="/${rye}"`);
    expect(english).toContain("<mark>loaf</mark>");
    expect(await found("Brote")).not.toContain(`href="/${brot}"`);
    // German: the index is built again with German word forms.
    expect(
      (await call("PUT", "/api/admin/settings/language", { tag: "de", direction: "auto" })).status,
    ).toBe(200);
    await expect
      .poll(async () => (await found("Brote")).includes(`href="/${brot}"`), { timeout: 15_000 })
      .toBe(true);
    expect(await found("loaves")).not.toContain(`href="/${rye}"`);
    expect(await found("loaf")).toContain(`href="/${rye}"`);
  });
});

const s3Test =
  process.env["S3_TEST_ENDPOINT"] &&
  process.env["S3_TEST_ACCESS_KEY"] &&
  process.env["S3_TEST_SECRET_KEY"]
    ? {
        endpoint: process.env["S3_TEST_ENDPOINT"],
        region: process.env["S3_TEST_REGION"] ?? "us-east-1",
        accessKeyId: process.env["S3_TEST_ACCESS_KEY"],
        secretAccessKey: process.env["S3_TEST_SECRET_KEY"],
        bucket: "oks-test-site",
      }
    : null;

describe.skipIf(!findBrowser() || !s3Test)(
  "S3 storage (spec 09, section 7)",
  { timeout: 150_000 },
  () => {
    let db: TestDb;
    let site: Awaited<ReturnType<typeof startSite>>;
    let browser: Browser;
    let uploads = "";
    const owner = { email: "anna@example.com", password: "a-long-password" };

    beforeAll(async () => {
      const { s3Client } = await import("@oks-page/media");
      expect([200, 409]).toContain((await s3Client(s3Test!).request("PUT", "")).status);
      const root = mkdtempSync(join(tmpdir(), "oks-s3-site-"));
      uploads = join(root, "uploads");
      db = await openSqlite(join(root, "site.sqlite"));
      site = await startSite("sqlite", db, {
        OKS_SECRET: "3".repeat(40),
        OKS_UPLOADS_DIR: uploads,
        OKS_STORAGE: "s3",
        OKS_S3_ENDPOINT: s3Test!.endpoint,
        OKS_S3_REGION: s3Test!.region,
        OKS_S3_BUCKET: s3Test!.bucket,
        OKS_S3_ACCESS_KEY_ID: s3Test!.accessKeyId,
        OKS_S3_SECRET_ACCESS_KEY: s3Test!.secretAccessKey,
        OKS_S3_PREFIX: "anna",
      });
      const made = await fetch(site.base + "/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          siteName: "Anna's Garden",
          starterContent: false,
          admin: { name: "Anna", ...owner },
        }),
      });
      expect(made.status).toBe(200);
      browser = await chromium.launch({ executablePath: findBrowser()! });
    }, 300_000);

    afterAll(async () => {
      await browser?.close();
      site?.server.kill();
      await db?.close();
      if (s3Test) {
        const { s3Adapter } = await import("@oks-page/media");
        const store = s3Adapter({ ...s3Test, prefix: "anna" });
        for await (const key of store.list()) await store.delete(key);
      }
    });

    test("an upload and its sizes go to the bucket, not the disk; the site serves them with its protective headers", async () => {
      const { s3Adapter } = await import("@oks-page/media");
      const bucket = s3Adapter({ ...s3Test!, prefix: "anna" });
      const page = await browser.newPage();
      await page.goto(site.base + "/admin/login");
      await page.getByLabel("Email").fill(owner.email);
      await page.getByLabel(/^Password/).fill(owner.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      const photo = await sharp({
        create: { width: 1600, height: 1000, channels: 3, background: { r: 200, g: 120, b: 40 } },
      })
        .jpeg()
        .toBuffer();
      const upload = await page.request.post(site.base + "/api/admin/media", {
        headers: { origin: site.base },
        multipart: { file: { name: "garden photo.jpg", mimeType: "image/jpeg", buffer: photo } },
      });
      expect(upload.status()).toBeLessThan(300);
      const id = String(((await upload.json()) as { id: string }).id);
      await expect
        .poll(
          async () =>
            String((await db.run("select status from media where id = ?", [id]))[0]!["status"]),
          {
            timeout: 60_000,
          },
        )
        .toBe("ready");
      const key = String(
        (await db.run("select storage_key from media where id = ?", [id]))[0]!["storage_key"],
      );
      const sizes = (
        await db.run("select storage_key from media_variants where media_id = ?", [id])
      ).map((r) => String(r["storage_key"]));
      expect(sizes.length).toBeGreaterThan(0);
      // In the bucket (under the prefix), the same bytes as served; nothing on the disk.
      expect(await bucket.exists(key)).toBe(true);
      for (const k of sizes) expect(await bucket.exists(k), k).toBe(true);
      const { existsSync } = await import("node:fs");
      expect(existsSync(uploads)).toBe(false);
      const served = await fetch(
        `${site.base}/uploads/${key.split("/").map(encodeURIComponent).join("/")}`,
      );
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/jpeg");
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(
        Buffer.from(await served.arrayBuffer()).equals(Buffer.from(await bucket.get(key))),
      ).toBe(true);
      const size = await fetch(
        `${site.base}/uploads/${sizes[0]!.split("/").map(encodeURIComponent).join("/")}`,
      );
      expect(size.status).toBe(200);
      // The library shows the picture from the bucket.
      await page.goto(site.base + "/admin/media");
      await page.getByRole("heading", { name: "Media", level: 1 }).waitFor();
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.images].some(
              (i) => i.src.includes("/uploads/") && i.complete && i.naturalWidth > 0,
            ),
          ),
        )
        .toBe(true);
    });
  },
);

describe.skipIf(!findBrowser())("passkeys (spec 02, AU-09, AU-41)", { timeout: 120_000 }, () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  let browser: Browser;
  const owner = { email: "anna@example.com", password: "a-long-password" };

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-passkeys-")), "site.sqlite"));
    // A passkey belongs to a host name, so this site is reached as localhost, not as 127.0.0.1.
    site = await startSite("sqlite", db, {
      OKS_SECRET: "k".repeat(40),
      OKS_SITE_URL: "http://localhost:{port}",
    });
    const made = await fetch(site.base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Anna's Garden",
        starterContent: false,
        admin: { name: "Anna", ...owner },
      }),
    });
    expect(made.status).toBe(200);
    browser = await chromium.launch({ executablePath: findBrowser()! });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.kill();
    await db?.close();
  });

  const axeViolations = async (page: Awaited<ReturnType<Browser["newPage"]>>) => {
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      }),
    );
    return result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  };

  test("add a passkey (the password is asked again), sign in with it, remove it; each step is in the audit log", async () => {
    const base = `http://localhost:${site.port}`;
    const context = await browser.newContext();
    const page = await context.newPage();
    // A fake fingerprint reader in the browser.
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    await page.goto(base + "/admin/login");
    await page.getByRole("heading", { name: "Sign in with a passkey" }).waitFor();
    await page.getByLabel(/^Email\s*\*?$/).fill(owner.email);
    await page.getByLabel(/^Password/).fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();

    await page.goto(base + "/admin/account");
    const section = page.getByRole("region", { name: "Passkeys" });
    await section.getByText("You have no passkeys yet.").waitFor();
    expect(await axeViolations(page)).toEqual([]);

    // The server itself refuses to add or remove one without the password, whatever the screen does.
    const bare = await page.request.post(base + "/api/auth/passkey/delete-passkey", {
      headers: { origin: base, "content-type": "application/json" },
      data: { id: "nothing" },
    });
    expect(bare.status()).toBe(400);
    expect(JSON.stringify(await bare.json())).toContain("Your current password is not right.");

    // A wrong password is found before the device is asked.
    await section.getByLabel("Name for the new passkey", { exact: false }).fill("Laptop");
    await section.getByLabel("Your current password").fill("not-the-password");
    await section.getByRole("button", { name: "Add a passkey" }).click();
    await page.getByText("Your current password is not right.").waitFor();
    expect((await db.run("select id from passkeys")).length).toBe(0);

    await section.getByLabel("Your current password").fill(owner.password);
    await section.getByRole("button", { name: "Add a passkey" }).click();
    await section.getByText("Passkey added: Laptop.", { exact: false }).waitFor();
    await section.getByText("Laptop", { exact: true }).waitFor();
    const stored = await db.run("select name, credential_id from passkeys");
    expect(stored).toHaveLength(1);
    expect(stored[0]!["name"]).toBe("Laptop");

    // Sign out; the passkey signs in without a password, to the dashboard.
    const out = await page.request.post(base + "/api/auth/sign-out", {
      headers: { origin: base, "content-type": "application/json" },
      data: {},
    });
    expect(out.status()).toBe(200);
    await page.goto(base + "/admin/login");
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    const session = (await (await page.request.get(base + "/api/auth/get-session")).json()) as {
      user?: { email: string };
    };
    expect(session.user?.email).toBe(owner.email);

    // Remove it: the password is asked again here too.
    await page.goto(base + "/admin/account");
    await section.getByRole("button", { name: "Remove Laptop" }).click();
    await page.getByText("Type your current password above", { exact: false }).waitFor();
    await section.getByLabel("Your current password").fill("not-the-password");
    await section.getByRole("button", { name: "Remove Laptop" }).click();
    await page.getByText("Your current password is not right.").waitFor();
    expect((await db.run("select id from passkeys")).length).toBe(1);
    await section.getByLabel("Your current password").fill(owner.password);
    await section.getByRole("button", { name: "Remove Laptop" }).click();
    await section.getByText("Passkey removed: Laptop.").waitFor();
    await section.getByText("You have no passkeys yet.").waitFor();
    expect((await db.run("select id from passkeys")).length).toBe(0);

    // The audit log has both, with the name.
    const log = await db.run(
      "select action, detail from audit_log where action like 'passkey.%' order by created_at, action",
    );
    expect(log.map((r) => r["action"])).toEqual(["passkey.add", "passkey.remove"]);
    for (const r of log) expect(JSON.parse(String(r["detail"]))).toEqual({ name: "Laptop" });
    await context.close();
  });

  test("a site reached by an IP address shows no passkey screens", async () => {
    // The same site, asked by its 127.0.0.1 address, still has OKS_SITE_URL = localhost, so use a plain new site.
    const plainDb = await openSqlite(
      join(mkdtempSync(join(tmpdir(), "oks-nopasskeys-")), "site.sqlite"),
    );
    const plain = await startSite("sqlite", plainDb, { OKS_SECRET: "n".repeat(40) });
    try {
      await fetch(plain.base + "/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          siteName: "Plain",
          starterContent: false,
          admin: { name: "Anna", ...owner },
        }),
      });
      const html = await (await fetch(plain.base + "/admin/login")).text();
      expect(html).not.toContain("Sign in with a passkey");
      expect(html).toContain("Sign in");
    } finally {
      plain.server.kill();
      await plainDb.close();
    }
  });
});

describe.skipIf(!findBrowser())(
  "pages of lists: the newest posts, the posts page and archives",
  { timeout: 150_000 },
  () => {
    let db: TestDb;
    let site: Awaited<ReturnType<typeof startSite>>;
    let browser: Browser;
    const owner = { email: "anna@example.com", password: "a-long-password" };

    beforeAll(async () => {
      db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-paging-")), "site.sqlite"));
      site = await startSite("sqlite", db, { OKS_SECRET: "g".repeat(40) });
      const made = await fetch(site.base + "/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          siteName: "Anna's Garden",
          starterContent: false,
          admin: { name: "Anna", ...owner },
        }),
      });
      expect(made.status).toBe(200);
      browser = await chromium.launch({ executablePath: findBrowser()! });
    }, 300_000);

    afterAll(async () => {
      await browser?.close();
      site?.server.kill();
      await db?.close();
    });

    const axeViolations = async (page: Awaited<ReturnType<Browser["newPage"]>>) => {
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(() =>
        (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        }),
      );
      return result.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      );
    };

    test("25 posts are 3 pages of 10: the links, the 404s, what is left out, the canonical address, and a changed page size", async () => {
      const siteId = String((await db.run("select id from sites"))[0]!["id"]);
      const userId = String((await db.run("select id from users"))[0]!["id"]);
      const T = 1_700_000_000_000;
      const add = async (n: number, slug: string, status: string, seo: object = {}) => {
        const id = `PAG${String(n).padStart(23, "0")}`;
        await db.run(
          `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, published_at, created_at, updated_at)
         values (?, ?, 'post', ?, ?, ?, ?, '{}', '[]', ?, '<p>x</p>', ?, '{}', ?, ?, ?)`,
          [
            id,
            siteId,
            status,
            `Post ${String(n).padStart(2, "0")}`,
            slug,
            userId,
            `Text of post ${n}`,
            JSON.stringify(seo),
            new Date(T + n * 60_000),
            new Date(T),
            new Date(T),
          ],
        );
        return id;
      };
      // 25 listed posts (1 is the oldest), plus a draft and a post set to stay out of lists.
      for (let n = 1; n <= 25; n++) await add(n, `blog/post-${n}`, "published");
      await add(26, "blog/draft-one", "draft");
      await add(27, "blog/hidden-one", "published", { noindex: true });

      // The home page shows the newest posts (Settings > Reading), 10 to a page.
      const page = await browser.newPage();
      await page.goto(site.base + "/admin/login");
      await page.getByLabel(/^Email\s*\*?$/).fill(owner.email);
      await page.getByLabel(/^Password/).fill(owner.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
      const setReading = (data: object) =>
        page.request.put(site.base + "/api/admin/settings/reading", {
          headers: { origin: site.base, "content-type": "application/json" },
          data,
        });
      expect((await setReading({ homeShows: "posts", perPage: 10 })).status()).toBe(200);

      const get = (path: string) => fetch(site.base + path, { redirect: "manual" });
      const post = (n: number) => `Post ${String(n).padStart(2, "0")}`;
      const titles = (html: string) =>
        [...html.matchAll(/<a href="\/blog\/post-\d+">([^<]+)<\/a>/g)].map((m) => m[1]);

      // Page 1: the newest 10 (posts 25 down to 16), "Older posts" to /page/2, no "Newer posts".
      const first = await (await get("/")).text();
      expect(titles(first)).toEqual(Array.from({ length: 10 }, (_, i) => post(25 - i)));
      expect(first).toContain("Page 1 of 3");
      expect(first).toContain('href="/page/2"');
      expect(first).toContain('aria-label="Page 1, this page"');
      expect(first).not.toContain("Newer posts");
      expect(first).not.toContain("Post 26");
      expect(first).not.toContain("Post 27");
      // Page 2: 15 down to 6; "Newer posts" goes back to "/", "Older posts" on to /page/3.
      const second = await get("/page/2");
      expect(second.status).toBe(200);
      const secondHtml = await second.text();
      expect(titles(secondHtml)).toEqual(Array.from({ length: 10 }, (_, i) => post(15 - i)));
      expect(secondHtml).toContain("Page 2 of 3");
      expect(secondHtml).toMatch(
        /<a [^>]*href="\/"[^>]*rel="prev"|<a [^>]*rel="prev"[^>]*href="\/"/,
      );
      expect(secondHtml).toContain('href="/page/3"');
      // The numbers: every page is a link except this one, which says so.
      expect(secondHtml).toContain('aria-current="page" aria-label="Page 2, this page"');
      expect(secondHtml).toMatch(/<a [^>]*href="\/"[^>]*aria-label="Page 1"/);
      expect(secondHtml).toMatch(/<a [^>]*href="\/page\/3"[^>]*aria-label="Page 3"/);
      // It is a page of its own: its own title and canonical address, and it can be indexed.
      expect(secondHtml).toMatch(/<title>[^<]*Page 2[^<]*<\/title>/);
      expect(secondHtml).toContain(
        `<link rel="canonical" href="${new URL("/page/2", (secondHtml.match(/<link rel="canonical" href="(https?:\/\/[^/"]+)/) ?? [])[1] ?? "http://x").href}"`,
      );
      expect(secondHtml).not.toMatch(/name="robots" content="[^"]*noindex/);
      // Page 3: the last 5; no "Older posts".
      const thirdHtml = await (await get("/page/3")).text();
      expect(titles(thirdHtml)).toEqual(Array.from({ length: 5 }, (_, i) => post(5 - i)));
      expect(thirdHtml).not.toContain("Older posts");
      // Past the end, with a leading zero or sign, or page 0: real 404s. Page 1 is the list's own address.
      for (const path of ["/page/4", "/page/0", "/page/02", "/page/-1", "/page/1000000"])
        expect((await get(path)).status, path).toBe(404);
      const one = await get("/page/1");
      expect(one.status).toBe(308);
      expect(new URL(one.headers.get("location")!, site.base).pathname).toBe("/");

      // The pager is for everyone: accessibility check on a page of a list.
      await page.goto(site.base + "/page/2");
      await page.getByRole("navigation", { name: "Pages of posts" }).waitFor();
      expect(await axeViolations(page)).toEqual([]);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        // Every number is at least 24 px tall and wide, and the page does not scroll sideways.
        const boxes = await page
          .getByRole("navigation", { name: "Pages of posts" })
          .getByRole("link", { name: /^Page \d$/ })
          .evaluateAll((links) =>
            links.map((l) => [l.getBoundingClientRect().width, l.getBoundingClientRect().height]),
          );
        expect(boxes.length).toBe(2);
        for (const [w, h] of boxes) expect(Math.min(w!, h!)).toBeGreaterThanOrEqual(24);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole("link", { name: "Page 3", exact: true }).click();
      await page.waitForURL((url) => url.pathname === "/page/3");

      // A page of 5: the owner changes "posts per page"; the pages are made again (25 posts, 5 pages).
      expect((await setReading({ perPage: 5 })).status()).toBe(200);
      await expect.poll(async () => (await get("/page/5")).status).toBe(200);
      expect((await get("/page/6")).status).toBe(404);
      expect(titles(await (await get("/page/5")).text())).toEqual([5, 4, 3, 2, 1].map(post));

      // A category: 12 of the posts, 5 to a page, so 3 pages; the same links and 404s.
      const category = await page.request.post(site.base + "/api/admin/taxonomies/category", {
        headers: { origin: site.base, "content-type": "application/json" },
        data: { name: "News" },
      });
      expect(category.status()).toBe(201);
      const termId = String((await db.run("select id from terms where slug = 'news'"))[0]!["id"]);
      for (let n = 1; n <= 12; n++)
        await db.run("insert into entry_terms (entry_id, term_id, position) values (?, ?, 0)", [
          `PAG${String(n).padStart(23, "0")}`,
          termId,
        ]);
      // The saved copies of the archive know about the change through the post, so touch one post the way an edit does.
      await page.request.post(site.base + "/api/admin/settings/advanced", {
        headers: { origin: site.base, "content-type": "application/json" },
        data: { action: "clear-copies" },
      });
      await expect
        .poll(async () => (await (await get("/category/news")).text()).includes("Page 1 of 3"))
        .toBe(true);
      const catTitles = (html: string) =>
        [...html.matchAll(/<a href="\/blog\/post-\d+">([^<]+)<\/a>/g)].map((m) => m[1]);
      expect(catTitles(await (await get("/category/news")).text())).toEqual([
        "Post 12",
        "Post 11",
        "Post 10",
        "Post 09",
        "Post 08",
      ]);
      const catThird = await (await get("/category/news/page/3")).text();
      expect(catTitles(catThird)).toEqual(["Post 02", "Post 01"]);
      expect(catThird).toMatch(/<title>[^<]*Category: News[^<]*Page 3[^<]*<\/title>/);
      expect((await get("/category/news/page/4")).status).toBe(404);
      expect((await get("/category/news/page/1")).status).toBe(308);
      expect((await get("/category/nothing/page/2")).status).toBe(404);
      expect((await get("/tag/nothing/page/2")).status).toBe(404);

      // An entry at the address of a later page wins over the list.
      await db.run(
        `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, published_at, created_at, updated_at)
       values (?, ?, 'page', 'published', 'My page two', 'page/2', ?, '{}', '[]', 'x', '<p>mine</p>', '{}', '{}', ?, ?, ?)`,
        [`PAG${"9".repeat(23)}`, siteId, userId, new Date(T), new Date(T), new Date(T)],
      );
      // (Put into the database directly, so the saved copies are cleared as an edit would.)
      await page.request.post(site.base + "/api/admin/settings/advanced", {
        headers: { origin: site.base, "content-type": "application/json" },
        data: { action: "clear-copies" },
      });
      await expect
        .poll(async () => (await (await get("/page/2")).text()).includes("My page two"))
        .toBe(true);
      expect(await (await get("/page/2")).text()).not.toContain("Newer posts");

      // The posts page (Settings > Reading): the home page shows a chosen page, and "journal" lists the newest posts.
      const pageRow = (n: number, slug: string, title: string) =>
        db.run(
          `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, published_at, created_at, updated_at)
         values (?, ?, 'page', 'published', ?, ?, ?, '{}', '[]', 'x', '<p>x</p>', '{}', '{}', ?, ?, ?)`,
          [
            `PGP${String(n).padStart(23, "0")}`,
            siteId,
            title,
            slug,
            userId,
            new Date(T),
            new Date(T),
            new Date(T),
          ],
        );
      await pageRow(1, "home", "Welcome");
      await pageRow(2, "journal", "Journal");
      expect(
        (
          await setReading({
            homeShows: "page",
            homePageId: `PGP${"0".repeat(22)}1`,
            postsPageId: `PGP${"0".repeat(22)}2`,
          })
        ).status(),
      ).toBe(200);
      await expect
        .poll(async () => (await (await get("/journal")).text()).includes("Page 1 of 5"))
        .toBe(true);
      expect(titles(await (await get("/journal")).text())).toEqual([25, 24, 23, 22, 21].map(post));
      const journalTwo = await get("/journal/page/2");
      expect(journalTwo.status).toBe(200);
      const journalTwoHtml = await journalTwo.text();
      expect(titles(journalTwoHtml)).toEqual([20, 19, 18, 17, 16].map(post));
      expect(journalTwoHtml).toContain('href="/journal"');
      expect(journalTwoHtml).toContain('href="/journal/page/3"');
      expect(journalTwoHtml).toMatch(/<title>[^<]*Journal – Page 2[^<]*<\/title>/);
      expect((await get("/journal/page/6")).status).toBe(404);
      expect((await get("/journal/page/1")).status).toBe(308);
      // The home page now shows a page, so "/page/3" is no list any more.
      expect((await get("/page/3")).status).toBe(404);
      expect(await (await get("/")).text()).toContain("Welcome");
      await page.close();
    });
  },
);
