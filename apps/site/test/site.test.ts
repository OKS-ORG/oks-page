// The real site, built and started, against SQLite and PostgreSQL. SEO-01 to SEO-09, SEO-50, SEO-55.
import { openers, type TestDb } from "@oks-page/db/testing";
import { type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openSqlite } from "@oks-page/db/testing";
import axe from "axe-core";
import sharp from "sharp";
import { chromium, type Browser } from "playwright-core";
import { buildExport, buildSite, findBrowser, seed, siteDir, startSite } from "./helpers";

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

for (const { kind, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the export build against the server build (ST-01, ST-02)`, () => {
    let db: TestDb;
    let site: Awaited<ReturnType<typeof startSite>>;
    let out = "";
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
      await s.entry("about", "About us");
      await s.entry("docs/intro", "Intro");
      await s.entry("hidden", "Hidden", "draft");
      await s.entry("secret", "Secret", "private");
      site = await startSite(kind, db, { OKS_SITE_URL: SITE_URL });
      out = mkdtempSync(join(tmpdir(), "oks-exp-out-"));
      buildExport(kind, db, out, { OKS_SITE_URL: SITE_URL });
    }, 400_000);

    afterAll(async () => {
      site?.server.kill();
      await db?.close();
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
    ).toBe("Pages 3 Posts 1 Drafts 0");
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
    await page.getByRole("button", { name: "Add new" }).click();
    await page.getByRole("heading", { name: "Edit: Cara's draft", level: 1 }).waitFor();
    await page.getByText("An editor publishes it.").waitFor();
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
      body: JSON.stringify({ type: "page", title: "x" }),
    });
    expect(add.status).toBe(401);
    const save = await fetch(site.base + "/api/admin/entries/anything", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(save.status).toBe(401);
  });

  const addPageNamed = async (page: Page, title: string) => {
    await page.goto(site.base + "/admin/pages");
    await page.getByLabel(/^Title of the new page/).fill(title);
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
        data: { type: "page", title: "Uses a picture" },
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
      data: { type: "page", title: "Uses Busy" },
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
      data: { type: "page", title: "Gallery page" },
    });
    const pageId = ((await created.json()) as { id: string }).id;
    const page = await ownerPage();
    await page.goto(site.base + `/admin/pages/${pageId}`);
    await page.getByRole("heading", { name: "Edit: Gallery page", level: 1 }).waitFor();

    await page.getByRole("button", { name: "Insert image from the library" }).click();
    await page.getByRole("dialog", { name: "Insert an image from the library" }).waitFor();
    await page.getByRole("option", { name: /^Gallery-one\.png/ }).click();
    await page.getByRole("button", { name: "Insert image", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await expect.poll(() => page.locator(".oks-entry-editor img").count()).toBeGreaterThan(0);

    // A second picture, uploaded from the window: it is inserted at once.
    await page.getByRole("button", { name: "Insert image from the library" }).click();
    await page
      .getByRole("dialog")
      .locator("input[type=file]")
      .setInputFiles({ name: "Gallery two.png", mimeType: "image/png", buffer: await png("#088") });
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await expect.poll(() => page.locator(".oks-entry-editor img").count()).toBeGreaterThan(1);

    await page.getByLabel("Published (everyone sees it)").check({ force: true });
    await page.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => page.locator(".oks-entry-actions [role=status]").textContent())
      .toBe("Saved.");

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
      data: { type: "page", title: "Responsive page" },
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
      data: { type: "page", title: "Block upload" },
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
        data: { type: "page", title: `Axe page ${width}` },
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
});
