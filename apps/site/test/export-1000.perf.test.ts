// ST-23 repeated with oks-ui: the export build of 1,000 pages whose content is drawn with oks-ui components.
// A speed test: it runs alone (`pnpm test:perf`).
import { openSqlite, type TestDb } from "@oks-page/db/testing";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildExport, seed } from "./helpers";

const PAGES = 1000;

describe("ST-23: the export build of 1,000 pages with oks-ui", () => {
  let db: TestDb;
  let out = "";
  let seconds = 0;

  beforeAll(async () => {
    db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-st23-")), "site.sqlite"));
    const s = await seed(db);
    await s.entry("home", "Home");
    for (let i = 0; i < PAGES; i++)
      await s.entry(`blog/post-${i}`, `Post ${i}`, "published", "post");
    out = mkdtempSync(join(tmpdir(), "oks-st23-out-"));
    const started = Date.now();
    buildExport("sqlite", db, out);
    seconds = (Date.now() - started) / 1000;
    console.log(`ST-23: ${PAGES + 1} pages exported in ${seconds.toFixed(1)} s`);
  }, 600_000);

  afterAll(async () => {
    await db?.close();
  });

  test("every page is written, and each one is drawn with an oks-ui component", () => {
    const posts = readdirSync(join(out, "blog")).filter((f) => f.endsWith(".html"));
    expect(posts.length).toBe(PAGES);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain("oksCard");
    // Every post is drawn with the component, not only the one looked at below.
    for (const post of posts)
      expect(readFileSync(join(out, "blog", post), "utf8"), post).toContain("oksCard");
    expect(readFileSync(join(out, "blog", "post-777.html"), "utf8")).toContain("oksCard");
    expect(existsSync(join(out, "404.html"))).toBe(true);
  });

  test("the build takes under 60 seconds (the plain-HTML build measured 8.1 s in the spec)", () => {
    expect(seconds).toBeLessThan(60);
  });
});
