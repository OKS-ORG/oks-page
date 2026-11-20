// `oks publish` the command (spec 10, section 7): it needs one place to publish to and an exported site, and it says what it did.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runCli } from "./main.js";

// Every folder the tests make is taken away when they are done (the temporary folder is kept in memory on some computers).
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `oks-publish-${name}-`));
  made.push(dir);
  return dir;
};
const put = (dir: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};

describe("oks publish", () => {
  test("it needs one place to publish to, and an exported site", async () => {
    const lines: string[] = [];
    expect(await runCli(["publish", "nowhere"], (t) => lines.push(t))).toBe(2);
    expect(lines.join("\n")).toMatch(/--zip <file> or --folder <dir>/);
    expect(
      await runCli(["publish", "nowhere", "--zip", "x.zip", "--folder", "y"], () => undefined),
    ).toBe(2);
    const missing: string[] = [];
    expect(
      await runCli(["publish", join(tmpdir(), "no-such-oks-folder"), "--zip", "x.zip"], (t) =>
        missing.push(t),
      ),
    ).toBe(1);
    expect(missing.join("\n")).toMatch(/Run "oks export" first/);
  });

  test("it publishes to a folder, says what it sent, and says when nothing changed", async () => {
    const site = temp("cli-site");
    const live = temp("cli-live");
    put(site, { "index.html": "home", "style.css": "css" });
    const first: string[] = [];
    expect(await runCli(["publish", site, "--folder", live], (t) => first.push(t))).toBe(0);
    expect(first.join("\n")).toBe("Published: 2 files sent, 0 removed.");
    const second: string[] = [];
    expect(await runCli(["publish", site, "--folder", live], (t) => second.push(t))).toBe(0);
    expect(second.join("\n")).toBe("Nothing changed: the place already has this site.");
  });
});
