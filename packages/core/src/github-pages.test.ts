// Publishing to GitHub Pages (spec 10, section 7.2), against a small stand-in for GitHub's API that runs inside the test.
// The branch moves only at the last step, so a visitor sees the old site or the new one and never a mixture.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { githubPagesTarget, plainGithubError } from "./github-pages.js";
import { MANIFEST_FILE, publishSite } from "./publish.js";
import { TEST_GITHUB_TOKEN, startGithubServer } from "./testing/github-server.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const site = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "oks-github-site-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};
const target = (base: string, over: Record<string, unknown> = {}) =>
  githubPagesTarget({
    owner: "ada",
    repo: "site",
    branch: "gh-pages",
    token: TEST_GITHUB_TOKEN,
    apiBase: base,
    timeoutMs: 5000,
    ...over,
  });

describe("GitHub Pages", { timeout: 60_000 }, () => {
  test("a first publish makes the branch with every file, the record and .nojekyll, in one commit", async () => {
    const github = await startGithubServer();
    try {
      const dir = site({
        "index.html": "<p>home</p>",
        "_next/static/app.js": "js",
        "about/index.html": "<p>about</p>",
      });
      const report = await publishSite(dir, target(github.base));
      expect(report).toMatchObject({ ok: true, planned: 3 });
      const files = github.files("gh-pages")!;
      expect([...files.keys()].sort()).toEqual([
        ".nojekyll",
        MANIFEST_FILE,
        "_next/static/app.js",
        "about/index.html",
        "index.html",
      ]);
      expect(files.get("about/index.html")).toBe("<p>about</p>");
      // Pages runs Jekyll unless .nojekyll is there, and Jekyll would hide the _next folder.
      expect(files.get(".nojekyll")).toBe("");
      expect(github.commits("gh-pages")).toBe(1);
    } finally {
      await github.close();
    }
  });

  test("a second publish sends only what changed and removes what is gone, as one more commit", async () => {
    const github = await startGithubServer();
    try {
      const dir = site({ "index.html": "1", "old.html": "2", "style.css": "3" });
      await publishSite(dir, target(github.base));
      github.log.length = 0;
      writeFileSync(join(dir, "index.html"), "1 changed");
      rmSync(join(dir, "old.html"));
      const second = await publishSite(dir, target(github.base));
      expect(second).toMatchObject({ ok: true, planned: 2 });
      const files = github.files("gh-pages")!;
      expect(files.get("index.html")).toBe("1 changed");
      expect(files.has("old.html")).toBe(false);
      expect(files.get("style.css")).toBe("3");
      expect(github.commits("gh-pages")).toBe(2);
      // Three blobs: the changed file, the .nojekyll file (the same empty file as before) and the record. The files that
      // did not change were not sent again.
      expect(github.log.filter((l) => l === "POST /repos/ada/site/git/blobs")).toHaveLength(3);
      // Nothing changed: no new commit.
      expect((await publishSite(dir, target(github.base))).planned).toBe(0);
      expect(github.commits("gh-pages")).toBe(2);
    } finally {
      await github.close();
    }
  });

  test("a publish that fails in the middle leaves the branch as it was", async () => {
    const github = await startGithubServer();
    try {
      const dir = site({ "index.html": "1", "a.css": "2" });
      await publishSite(dir, target(github.base));
      const before = new Map(github.files("gh-pages")!);
      writeFileSync(join(dir, "index.html"), "new");
      writeFileSync(join(dir, "b.css"), "new b");
      github.failBlobsFrom(2);
      const cut = await publishSite(dir, target(github.base));
      expect(cut.ok).toBe(false);
      expect(cut.problem).toMatch(/GitHub answered with an error \(500\)/);
      expect(github.files("gh-pages")).toEqual(before);
      expect(github.commits("gh-pages")).toBe(1);
      // The next publish finishes the job.
      github.failBlobsFrom(null);
      expect((await publishSite(dir, target(github.base))).ok).toBe(true);
      expect(github.files("gh-pages")!.get("b.css")).toBe("new b");
    } finally {
      await github.close();
    }
  });

  test("a branch that this place did not publish is replaced, not mixed with, but its history is kept", async () => {
    const github = await startGithubServer();
    try {
      // Someone else's files on the branch: no record of an earlier publish by this place.
      github.seed("gh-pages", { "foreign.html": "not ours", "docs/readme.md": "also not ours" });
      const dir = site({ "index.html": "ours" });
      const report = await publishSite(dir, target(github.base));
      expect(report.ok).toBe(true);
      expect([...github.files("gh-pages")!.keys()].sort()).toEqual([
        ".nojekyll",
        MANIFEST_FILE,
        "index.html",
      ]);
      // The old commit is still in the branch's history.
      expect(github.commits("gh-pages")).toBe(2);
    } finally {
      await github.close();
    }
  });

  test("a wrong token, a missing repository and a missing permission are plain sentences, and nothing is sent", async () => {
    const github = await startGithubServer();
    try {
      const dir = site({ "index.html": "x" });
      const badToken = await publishSite(dir, target(github.base, { token: "wrong" }));
      expect(badToken.ok).toBe(false);
      expect(badToken.problem).toMatch(/GitHub refused the token/);
      const missing = await publishSite(dir, target(github.base, { repo: "nope" }));
      expect(missing.ok).toBe(false);
      expect(missing.problem).toMatch(/could not find ada\/nope/);
      expect(github.files("gh-pages")).toBeNull();
    } finally {
      await github.close();
    }
  });

  test("a server that nobody answers for is a plain sentence", async () => {
    const github = await startGithubServer();
    const base = github.base;
    await github.close();
    const report = await publishSite(site({ "index.html": "x" }), target(base));
    expect(report.ok).toBe(false);
    expect(report.problem).toMatch(/GitHub could not be reached/);
  });

  test("a file name that is not safe is refused", async () => {
    const t = target("http://127.0.0.1:9");
    await expect(t.put("../escape", Buffer.from("x"))).rejects.toThrow(/not a safe/);
    await expect(t.remove("/etc/passwd")).rejects.toThrow(/not a safe/);
  });

  test("the plain sentences for what GitHub says", () => {
    const where = { owner: "ada", repo: "site" };
    expect(plainGithubError(401, "Bad credentials", where)).toMatch(/refused the token/);
    expect(plainGithubError(403, "API rate limit exceeded", where)).toMatch(/too many requests/);
    expect(plainGithubError(403, "Resource not accessible", where)).toMatch(/permission/);
    expect(plainGithubError(404, "Not Found", where)).toMatch(/ada\/site/);
    expect(plainGithubError(422, "Update is not a fast forward", where)).toMatch(
      /refused the change/,
    );
  });
});
