// `oks publish` (spec 10, section 7; ST-18 to ST-21, ST-32 for the folder): only what changed is sent, in an order that leaves
// a working site at every stop point; a zip and a folder are made whole.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";
import { runCli } from "./main.js";
import {
  MANIFEST_FILE,
  folderTarget,
  isSafePath,
  manifestOf,
  planPublish,
  publishSite,
  zipOf,
  zipTarget,
  type Manifest,
  type PublishOp,
  type PublishTarget,
} from "./publish.js";

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
const manifest = (files: Record<string, string>): Manifest => ({ v: 1, files });
const paths = (ops: PublishOp[]) => ops.map((o) => `${o.kind}:${o.path}`);

describe("the plan (ST-18 to ST-21)", () => {
  test("files first, then pages, then deletions; a page is never sent before what it points to", () => {
    const next = manifest({
      "index.html": "h1",
      "about/index.html": "h2",
      "uploads/a.png": "h3",
      "style.css": "h4",
      "404.html": "h5",
    });
    const plan = planPublish(next, manifest({ "old.html": "x", "old/pic.png": "y" }));
    expect(paths(plan)).toEqual([
      "put:style.css",
      "put:uploads/a.png",
      "put:404.html",
      "put:about/index.html",
      "put:index.html",
      "delete:old.html",
      "delete:old/pic.png",
    ]);
  });

  test("an unchanged site sends nothing; a first publish sends everything", () => {
    const m = manifest({ "index.html": "a", "x.css": "b" });
    expect(planPublish(m, m)).toEqual([]);
    expect(planPublish(m, null)).toHaveLength(2);
  });

  test("5,000 pages with one changed, one added and one removed are three operations", () => {
    const before: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) before[`blog/post-${i}/index.html`] = `h${i}`;
    const after = { ...before, "blog/post-7/index.html": "changed", "blog/new/index.html": "new" };
    delete after["blog/post-9/index.html"];
    const plan = planPublish(manifest(after), manifest(before));
    expect(paths(plan).sort()).toEqual([
      "delete:blog/post-9/index.html",
      "put:blog/new/index.html",
      "put:blog/post-7/index.html",
    ]);
  });

  test("a site that is cut off after every step is still a working site; the opposite order breaks it (the control)", () => {
    // A page points to the files it needs. A working site has every page's files in place.
    const pages: Record<string, string[]> = {
      "index.html": ["style.v2.css", "logo.png"],
      "about/index.html": ["style.v2.css"],
    };
    const old: Record<string, string> = {
      "index.html": "i1",
      "about/index.html": "a1",
      "style.v1.css": "s1",
      "logo.png": "l1",
    };
    const oldPages: Record<string, string[]> = {
      "index.html": ["style.v1.css", "logo.png"],
      "about/index.html": ["style.v1.css"],
    };
    const next: Record<string, string> = {
      "index.html": "i2",
      "about/index.html": "a2",
      "style.v2.css": "s2",
      "logo.png": "l1",
    };
    const needs = (path: string, live: Set<string>, version: "old" | "new") => {
      const wanted = (version === "new" ? pages : oldPages)[path] ?? [];
      return wanted.every((f) => live.has(f));
    };
    const broken = (ops: PublishOp[]) => {
      let brokenStops = 0;
      const live = new Set(Object.keys(old));
      const version = new Map<string, "old" | "new">(Object.keys(oldPages).map((p) => [p, "old"]));
      const check = () => {
        for (const page of Object.keys(oldPages))
          if (live.has(page) && !needs(page, live, version.get(page)!)) return false;
        return true;
      };
      if (!check()) brokenStops++;
      for (const op of ops) {
        if (op.kind === "put") {
          live.add(op.path);
          if (op.path in pages) version.set(op.path, "new");
        } else live.delete(op.path);
        if (!check()) brokenStops++;
      }
      return brokenStops;
    };
    const good = planPublish(manifest(next), manifest(old));
    expect(broken(good)).toBe(0);
    // Delete first, pages before files: the control.
    const opposite: PublishOp[] = [
      { kind: "delete", path: "style.v1.css" },
      ...good.filter((o) => o.kind === "put").reverse(),
    ];
    expect(broken(opposite)).toBeGreaterThan(0);
  });

  test("a path that is not safe is refused", () => {
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "a\\b", "a/./b", "a\0b"])
      expect(isSafePath(bad), bad).toBe(false);
    expect(isSafePath("about/index.html")).toBe(true);
    expect(isSafePath("uploads/pic é.png")).toBe(true);
  });
});

describe("a folder", () => {
  test("a first publish copies the site, a second sends only what changed and removes what is gone", async () => {
    const site = temp("site");
    const live = temp("live");
    put(site, {
      "index.html": "<p>home</p>",
      "about/index.html": "<p>about</p>",
      "uploads/a.png": "PNG",
      "old.html": "<p>old</p>",
    });
    const first = await publishSite(site, folderTarget(live));
    expect(first).toMatchObject({ ok: true, planned: 4 });
    expect(readFileSync(join(live, "about/index.html"), "utf8")).toBe("<p>about</p>");
    expect(existsSync(join(live, MANIFEST_FILE))).toBe(true);

    put(site, { "index.html": "<p>home 2</p>", "new.html": "<p>new</p>" });
    writeFileSync(join(site, "old.html"), "<p>old</p>");
    rmSync(join(site, "old.html"));
    const steps: string[] = [];
    const second = await publishSite(site, folderTarget(live), {
      onStep: (op) => steps.push(`${op.kind}:${op.path}`),
    });
    expect(second.ok).toBe(true);
    // Not the files that did not change.
    expect(steps).toEqual(["put:index.html", "put:new.html", "delete:old.html"]);
    expect(readFileSync(join(live, "index.html"), "utf8")).toBe("<p>home 2</p>");
    expect(existsSync(join(live, "old.html"))).toBe(false);
    // No half-written file stays behind, and a third publish has nothing to do.
    expect(readdirSync(live).filter((f) => f.endsWith(".oks-part"))).toEqual([]);
    expect((await publishSite(site, folderTarget(live))).planned).toBe(0);
  });

  test("a cut connection leaves the place as it was, and the next publish finishes the job", async () => {
    const site = temp("cut-site");
    const live = temp("cut-live");
    put(site, { "index.html": "1", "a.css": "css", "about/index.html": "2" });
    const real = folderTarget(live);
    let sent = 0;
    const flaky: PublishTarget = {
      ...real,
      async put(path, bytes) {
        if (++sent === 2) throw new Error("connection lost");
        return real.put(path, bytes);
      },
    };
    const cut = await publishSite(site, flaky);
    expect(cut.ok).toBe(false);
    expect(cut.problem).toMatch(/connection lost/);
    expect(cut.done).toHaveLength(1);
    // The record was not written, so the next publish does everything that is missing.
    expect(existsSync(join(live, MANIFEST_FILE))).toBe(false);
    const again = await publishSite(site, real);
    expect(again.ok).toBe(true);
    expect(readFileSync(join(live, "about/index.html"), "utf8")).toBe("2");
  });

  test("a folder never writes outside itself", async () => {
    const live = temp("guard");
    const target = folderTarget(live);
    await expect(target.put("../escape.txt", Buffer.from("x"))).rejects.toThrow(/not a safe/);
    await expect(target.remove("/etc/passwd")).rejects.toThrow(/not a safe/);
  });
});

describe("a zip file", () => {
  /** Reads a zip back with the plain rules of the format. */
  function unzip(buffer: Buffer): Record<string, string> {
    const out: Record<string, string> = {};
    const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = buffer.readUInt16LE(end + 10);
    let at = buffer.readUInt32LE(end + 16);
    for (let i = 0; i < count; i++) {
      const method = buffer.readUInt16LE(at + 10);
      const size = buffer.readUInt32LE(at + 20);
      const nameLength = buffer.readUInt16LE(at + 28);
      const offset = buffer.readUInt32LE(at + 42);
      const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
      const start =
        offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
      const body = buffer.subarray(start, start + size);
      out[name] = (method === 8 ? inflateRawSync(body) : body).toString("utf8");
      at += 46 + nameLength;
    }
    return out;
  }

  test("every file is in the zip with its text, in a fixed order, and the same site gives the same bytes", () => {
    const files = [
      { path: "b/index.html", data: Buffer.from("<p>b</p>".repeat(50)) },
      { path: "a.txt", data: Buffer.from("x") },
      { path: "empty.txt", data: Buffer.alloc(0) },
      { path: "uploads/pic é.png", data: Buffer.from("PNGDATA") },
    ];
    const zip = zipOf(files);
    expect(unzip(zip)).toEqual({
      "a.txt": "x",
      "b/index.html": "<p>b</p>".repeat(50),
      "empty.txt": "",
      "uploads/pic é.png": "PNGDATA",
    });
    expect(zipOf([...files].reverse()).equals(zip)).toBe(true);
  });

  test("a site is published to a zip file, and a real unzip tool accepts it", async () => {
    const site = temp("zip-site");
    const dir = temp("zip-out");
    put(site, { "index.html": "<p>home</p>", "uploads/a.png": "PNG" });
    const file = join(dir, "site.zip");
    const report = await publishSite(site, zipTarget(file));
    expect(report.ok).toBe(true);
    expect(unzip(readFileSync(file))).toEqual({
      "index.html": "<p>home</p>",
      "uploads/a.png": "PNG",
    });
    try {
      execFileSync("unzip", ["-tq", file], { stdio: "pipe" });
    } catch (error) {
      // Without an unzip program the check is skipped; with one, a failure is a real failure.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
});

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

describe("the manifest", () => {
  test("it lists plain files with their hashes and leaves out its own record", () => {
    const dir = temp("manifest");
    put(dir, { "a.txt": "x", "sub/b.txt": "y", [MANIFEST_FILE]: "{}" });
    const m = manifestOf(dir);
    expect(Object.keys(m.files)).toEqual(["a.txt", "sub/b.txt"]);
    expect(m.files["a.txt"]).toMatch(/^[0-9a-f]{64}$/);
  });
});
