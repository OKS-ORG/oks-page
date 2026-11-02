import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { exportSite } from "./export.js";

const dirs: string[] = [];
function tmp(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "oks-exp-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const goodBuild = async (_site: string, out: string) => {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "index.html"), "<p>home</p>");
  writeFileSync(join(out, "404.html"), "<p>missing</p>");
};

describe("oks export", () => {
  test("ST-30: a failed check stops the export before anything is built", async () => {
    const site = tmp({ "src/proxy.ts": "export function proxy() {}" });
    let built = false;
    const result = await exportSite(site, {
      out: join(site, "out"),
      build: async () => {
        built = true;
      },
    });
    expect(result.ok).toBe(false);
    expect(built).toBe(false);
    expect(result.check.issues[0]!.code).toBe("proxy-file");
  });

  test("ST-30: files the export build leaves out (export/removed.json) are not checked", async () => {
    const site = tmp({
      "src/proxy.ts": "export function proxy() {}",
      "export/removed.json": JSON.stringify({ removed: ["src/proxy.ts"], replaced: {} }),
    });
    const result = await exportSite(site, { out: join(site, "out"), build: goodBuild });
    expect(result.check.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  test("ST-13: the redirect files are written into the export, unsafe ones are reported", async () => {
    const site = tmp();
    const out = join(site, "out");
    const result = await exportSite(site, {
      out,
      build: goodBuild,
      redirects: [
        { from: "/old", to: "/new/" },
        { from: "/bad*", to: "/new/" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(out, "_redirects"), "utf8")).toBe("/old /new/ 301\n");
    expect(existsSync(join(out, "old", "index.html"))).toBe(true);
    expect(result.refusedRedirects).toHaveLength(1);
    expect(result.written).toEqual(["_redirects", ".htaccess", "old/index.html"]);
  });

  test("ST-30: an export with no 404 page is reported as a problem", async () => {
    const site = tmp();
    const result = await exportSite(site, {
      out: join(site, "out"),
      build: async (_s, out) => {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "index.html"), "x");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["The export has no 404.html."]);
  });
});
