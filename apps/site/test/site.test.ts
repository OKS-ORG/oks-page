// The real site, built and started, against SQLite and PostgreSQL. SEO-01 to SEO-09, SEO-50, SEO-51, SEO-55.
import { openers, type TestDb } from "@oks-page/db/testing";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openSqlite } from "@oks-page/db/testing";

const siteDir = join(import.meta.dirname, "..");
const next = join(siteDir, "node_modules", "next", "dist", "bin", "next");
const T = new Date(1_700_000_000_000);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

beforeAll(() => {
  // One build serves both databases: the pages read the database only when they are asked for.
  execFileSync(process.execPath, [next, "build"], {
    cwd: siteDir,
    env: { ...process.env, OKS_SQLITE_PATH: "/nonexistent", OKS_BUILD: "" },
    stdio: "pipe",
  });
}, 300_000);

async function seed(db: TestDb) {
  const site = "SITE0000000000000000000001";
  const user = "USER0000000000000000000001";
  await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
    site,
    T,
    T,
  ]);
  await db.run(
    "insert into users (id, name, email, created_at, updated_at) values (?, 'U', 'u@example.com', ?, ?)",
    [user, T, T],
  );
  let n = 0;
  const entry = async (slug: string, title: string, status = "published", type = "page") => {
    const id = `ENT${String(++n).padStart(23, "0")}`;
    await db.run(
      "insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, ?, '{}', '{}', ?, ?)",
      [id, site, type, status, title, slug, user, title, `<p>${title} body</p>`, T, T],
    );
    return id;
  };
  return { site, user, entry };
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
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OKS_TEST: "1",
        PORT: String(port),
        NODE_ENV: "production",
      };
      if (kind === "sqlite") env["OKS_SQLITE_PATH"] = db.location;
      else {
        env["OKS_DATABASE_URL"] = process.env["DATABASE_URL"]!;
        env["OKS_PG_SEARCH_PATH"] = db.location;
      }
      server = spawn(process.execPath, [next, "start", "-p", String(port), "-H", "127.0.0.1"], {
        cwd: siteDir,
        env,
        stdio: "pipe",
      });
      let log = "";
      server.stdout?.on("data", (d) => (log += d));
      server.stderr?.on("data", (d) => (log += d));
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(`${base}/not-found-handler`)).status === 404) return;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("The site did not start:\n" + log);
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
      expect(await res.text()).toContain('name="robots" content="noindex"');
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

    test("SEO-51 the proxy lookup adds under 5 ms at the 95th percentile", async () => {
      await stats(true);
      for (let i = 0; i < 300; i++) await get(i % 2 ? "/about" : `/missing-${i}`);
      const times = (await stats()).proxyMs.sort((a, b) => a - b);
      expect(times.length).toBeGreaterThanOrEqual(300);
      const p95 = times[Math.floor(times.length * 0.95)]!;
      console.log(
        `${kind}: proxy lookup p95 ${p95.toFixed(2)} ms, median ${times[Math.floor(times.length / 2)]!.toFixed(2)} ms`,
      );
      expect(p95).toBeLessThan(5);
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
