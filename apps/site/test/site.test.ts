// The real site, built and started, against SQLite and PostgreSQL. SEO-01 to SEO-09, SEO-50, SEO-55.
import { openers, type TestDb } from "@oks-page/db/testing";
import { type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openSqlite } from "@oks-page/db/testing";
import axe from "axe-core";
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
      await refresh(a, { tag: `entry:${ids["about"]}`, mode: "expire0" });
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
