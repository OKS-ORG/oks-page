// Publishing to Netlify (spec 10, section 7.2), against a small stand-in for Netlify's deploy API that runs inside the test.
// The deploy goes live as one: a visitor sees the old site or the new one, never a mixture.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { netlifyTarget, plainNetlifyError } from "./netlify.js";
import { publishSite } from "./publish.js";
import { TEST_NETLIFY_TOKEN, startNetlifyServer } from "./testing/netlify-server.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const site = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "oks-netlify-site-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};
const target = (base: string, over: Record<string, unknown> = {}) =>
  netlifyTarget({
    site: "my-site",
    token: TEST_NETLIFY_TOKEN,
    apiBase: base,
    timeoutMs: 5000,
    pollMs: 5,
    waitMs: 3000,
    ...over,
  });

describe("Netlify", { timeout: 60_000 }, () => {
  test("a first publish uploads every file and the deploy goes live as one", async () => {
    const netlify = await startNetlifyServer();
    try {
      const dir = site({
        "index.html": "<p>home</p>",
        "_next/static/app.js": "js",
        _redirects: "/old /new/ 301",
      });
      const report = await publishSite(dir, target(netlify.base));
      expect(report).toMatchObject({ ok: true, planned: 3 });
      expect([...netlify.live().keys()].sort()).toEqual([
        "_next/static/app.js",
        "_redirects",
        "index.html",
      ]);
      expect(netlify.live().get("_redirects")).toBe("/old /new/ 301");
      expect(netlify.uploads.sort()).toEqual(["_next/static/app.js", "_redirects", "index.html"]);
    } finally {
      await netlify.close();
    }
  });

  test("a second publish uploads only the files Netlify lacks, and files that are gone leave the live site", async () => {
    const netlify = await startNetlifyServer();
    try {
      const dir = site({ "index.html": "1", "old.html": "2", "style.css": "3" });
      await publishSite(dir, target(netlify.base));
      netlify.uploads.length = 0;
      writeFileSync(join(dir, "index.html"), "1 changed");
      rmSync(join(dir, "old.html"));
      const second = await publishSite(dir, target(netlify.base));
      expect(second.ok).toBe(true);
      expect(netlify.uploads).toEqual(["index.html"]);
      expect([...netlify.live().keys()].sort()).toEqual(["index.html", "style.css"]);
      expect(netlify.live().get("index.html")).toBe("1 changed");
    } finally {
      await netlify.close();
    }
  });

  test("an upload that fails leaves the live site as it was, and the next publish finishes the job", async () => {
    const netlify = await startNetlifyServer();
    try {
      const dir = site({ "index.html": "1", "a.css": "2" });
      await publishSite(dir, target(netlify.base));
      const before = new Map(netlify.live());
      writeFileSync(join(dir, "index.html"), "new");
      writeFileSync(join(dir, "b.css"), "new b");
      netlify.failUploadsFrom(2);
      const cut = await publishSite(dir, target(netlify.base));
      expect(cut.ok).toBe(false);
      expect(cut.problem).toMatch(/Netlify answered with an error \(500\)/);
      expect(netlify.live()).toEqual(before);
      netlify.failUploadsFrom(null);
      expect((await publishSite(dir, target(netlify.base))).ok).toBe(true);
      expect(netlify.live().get("b.css")).toBe("new b");
    } finally {
      await netlify.close();
    }
  });

  test("a deploy that Netlify ends in an error says why, and the live site stays", async () => {
    const netlify = await startNetlifyServer();
    try {
      const dir = site({ "index.html": "1" });
      await publishSite(dir, target(netlify.base));
      writeFileSync(join(dir, "index.html"), "2");
      netlify.failNextDeploy("Invalid _redirects file");
      const report = await publishSite(dir, target(netlify.base));
      expect(report.ok).toBe(false);
      expect(report.problem).toMatch(/could not finish the deploy: Invalid _redirects file/);
      expect(netlify.live().get("index.html")).toBe("1");
    } finally {
      await netlify.close();
    }
  });

  test("a deploy that never finishes is a plain sentence", async () => {
    const netlify = await startNetlifyServer();
    try {
      const dir = site({ "index.html": "1" });
      // The stand-in needs two looks to finish; a wait of almost nothing is too short.
      netlify.stall(true);
      const report = await publishSite(dir, target(netlify.base, { waitMs: 100, pollMs: 20 }));
      expect(report.ok).toBe(false);
      expect(report.problem).toMatch(/took too long/);
    } finally {
      await netlify.close();
    }
  });

  test("a wrong token and a missing site are plain sentences, and nothing goes live", async () => {
    const netlify = await startNetlifyServer();
    try {
      const dir = site({ "index.html": "x" });
      const badToken = await publishSite(dir, target(netlify.base, { token: "wrong" }));
      expect(badToken.problem).toMatch(/Netlify refused the token/);
      const missing = await publishSite(dir, target(netlify.base, { site: "nope" }));
      expect(missing.problem).toMatch(/could not find the site nope/);
      expect(netlify.live().size).toBe(0);
    } finally {
      await netlify.close();
    }
  });

  test("a server that nobody answers for is a plain sentence", async () => {
    const netlify = await startNetlifyServer();
    const base = netlify.base;
    await netlify.close();
    const report = await publishSite(site({ "index.html": "x" }), target(base));
    expect(report.ok).toBe(false);
    expect(report.problem).toMatch(/Netlify could not be reached/);
  });

  test("a file name that is not safe is refused", async () => {
    const t = target("http://127.0.0.1:9");
    await expect(t.put("../escape", Buffer.from("x"))).rejects.toThrow(/not a safe/);
  });

  test("the plain sentences for what Netlify says", () => {
    expect(plainNetlifyError(401, "Access Denied", "s")).toMatch(/refused the token/);
    expect(plainNetlifyError(403, "x", "s")).toMatch(/may not deploy/);
    expect(plainNetlifyError(404, "x", "my-site")).toMatch(/my-site/);
    expect(plainNetlifyError(429, "x", "s")).toMatch(/too many requests/);
    expect(plainNetlifyError(500, "boom", "s")).toMatch(/error \(500\): boom/);
  });
});
