import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { localAdapter, type StorageAdapter } from "@oks-page/media";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import {
  installTheme,
  listThemes,
  loadActiveThemeCssKey,
  removeTheme,
  rollBackTheme,
  themeFileMatches,
  themeFileType,
  useTheme,
} from "./theme-install.js";

// ----- a tiny tar writer (plain files only)

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.fill(32, 148, 156);
  h.write("0", 156);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}
function tgz(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    parts.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const png = Buffer.from("iVBORw0KGgo=", "base64");
const block = (type: string, props: Record<string, unknown> = {}) => ({
  id: Math.random().toString(36).slice(2, 10),
  type,
  props,
  content: null,
  children: [],
});
/** A theme package; `version` and `css` change between the versions in the tests. */
const maple = (version = "1.0.0", css = "body{background:url(assets/bg.png)}", bg: Buffer = png) =>
  tgz({
    "theme.json": JSON.stringify({
      key: "maple",
      name: "Maple",
      version,
      description: "A warm theme.",
      author: "Maple Studio",
      license: "MIT",
      rtl: "supported",
      tokens: { color: { "primary-700": "#2a6f4f" }, font: { body: "Maple Sans" } },
      fonts: [{ family: "Maple Sans", weight: 400, file: "assets/maple.woff2" }],
    }),
    "styles/theme.css": css,
    "assets/bg.png": bg,
    "assets/maple.woff2": "wOF2 maple",
    "templates/index.json": JSON.stringify({ blocks: [block("part", { name: "header" })] }),
    "parts/header.json": JSON.stringify({ blocks: [block("site-title")] }),
    "patterns/hero.json": JSON.stringify({ blocks: [block("heading")] }),
  });

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("served theme files", () => {
  test("only themes/<sha256>.<type> has a type, and a file must match its name", () => {
    const h = sha("x");
    expect(themeFileType(`themes/${h}.css`)).toBe("text/css; charset=utf-8");
    expect(themeFileType(`themes/${h}.woff2`)).toBe("font/woff2");
    expect(themeFileType(`themes/${h}.jpeg`)).toBe("image/jpeg");
    for (const bad of [
      `themes/${h}.svg`,
      `themes/${h}.js`,
      `theme-packages/${h}.tgz`,
      `themes/${h.slice(1)}.css`,
      `themes/../${h}.css`,
      `2026/11/${h}.css`,
    ])
      expect(themeFileType(bad)).toBeNull();
    expect(themeFileMatches(`themes/${h}.css`, Buffer.from("x"))).toBe(true);
    expect(themeFileMatches(`themes/${h}.css`, Buffer.from("y"))).toBe(false);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: installing and using themes`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;
    let dir = "";
    let storage: StorageAdapter;
    const stored = async () =>
      (await readdir(path.join(dir, "themes")).catch(() => [] as string[])).sort();
    const packages = async () =>
      (await readdir(path.join(dir, "theme-packages")).catch(() => [] as string[])).sort();
    const cssOf = async (key: string | null) =>
      key ? Buffer.from(await storage.get(key)).toString("utf8") : "";

    beforeEach(async () => {
      db = await open();
      dir = await mkdtemp(path.join(tmpdir(), "oks-themes-"));
      storage = localAdapter({ root: dir, baseUrl: "/uploads" });
      const result = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, name, email, T, T],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          tagline: "Plants and pots",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = result.siteId;
      admin = actorOf(result.userId, "administrator");
      editor = actorOf(result.userId, "editor");
    });
    afterEach(async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    test("a good package is stored, not in use, with every file named by its fingerprint", async () => {
      const archive = maple();
      const result = await installTheme(db.runner, storage, admin, siteId, archive);
      if (!result.ok) throw new Error(result.message);
      expect(result.change).toBe("new");
      expect(result.theme).toMatchObject({
        key: "maple",
        name: "Maple",
        version: "1.0.0",
        author: "Maple Studio",
        rtl: "supported",
        isActive: false,
        previousVersion: null,
        layouts: 1,
        parts: 1,
        sections: 1,
        fonts: 1,
      });
      expect(result.report.refused).toEqual([]);
      expect(result.report.passed.length).toBeGreaterThan(0);

      // The picture, the font and the CSS file, each named by the SHA-256 of its bytes; and the package itself.
      const files = await stored();
      expect(files).toContain(`${sha(png)}.png`);
      expect(files).toContain(`${sha("wOF2 maple")}.woff2`);
      expect(files.filter((f) => f.endsWith(".css"))).toHaveLength(1);
      expect(await packages()).toEqual([`${sha(archive)}.tgz`]);
      for (const f of files)
        expect(themeFileMatches(`themes/${f}`, await storage.get(`themes/${f}`))).toBe(true);

      // The CSS: the font, the design values, then the theme's CSS with its address pointing to the stored picture.
      const cssFile = files.find((f) => f.endsWith(".css"))!;
      const css = await cssOf(`themes/${cssFile}`);
      expect(css).toContain(
        `@font-face{font-family:"Maple Sans";src:url("/uploads/themes/${sha("wOF2 maple")}.woff2") format("woff2");font-weight:400;font-style:normal;font-display:swap}`,
      );
      expect(css).toContain("--oks-color-primary-700:#2a6f4f");
      expect(css).toContain(`body{background:url("/uploads/themes/${sha(png)}.png")}`);
      expect(css).not.toContain("assets/");

      // Installed is not in use: the public pages load nothing yet.
      expect(await loadActiveThemeCssKey(db.runner, siteId)).toBeNull();
      expect((await listThemes(db.runner, siteId)).map((t) => t.key)).toEqual(["maple"]);
    });

    test("a refused package stores nothing at all (TH-48), and only theme managers may install", async () => {
      const bad = tgz({
        "theme.json": JSON.stringify({ key: "maple", name: "Maple", version: "1.0.0" }),
        "assets/bg.png": png,
        "evil.js": "alert(1)",
      });
      const result = await installTheme(db.runner, storage, admin, siteId, bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("invalid");
      expect(result.report?.refused.join(" ")).toContain("evil.js");
      expect(await stored()).toEqual([]);
      expect(await packages()).toEqual([]);
      expect(await listThemes(db.runner, siteId)).toEqual([]);

      const denied = await installTheme(db.runner, storage, editor, siteId, maple());
      expect(denied).toMatchObject({ ok: false, code: "forbidden" });
      expect(await stored()).toEqual([]);
    });

    test("using a theme, going back to the built-in design, and only one in use", async () => {
      const first = await installTheme(db.runner, storage, admin, siteId, maple());
      const other = await installTheme(
        db.runner,
        storage,
        admin,
        siteId,
        tgz({ "theme.json": JSON.stringify({ key: "birch", name: "Birch", version: "2.0.0" }) }),
      );
      if (!first.ok || !other.ok) throw new Error("install failed");
      expect(await useTheme(db.runner, editor, siteId, first.theme.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await useTheme(db.runner, admin, siteId, "01J00000000000000000000000")).toMatchObject({
        ok: false,
        code: "not_found",
      });

      const used = await useTheme(db.runner, admin, siteId, first.theme.id);
      expect(used).toMatchObject({ ok: true, active: { key: "maple", isActive: true } });
      const key = await loadActiveThemeCssKey(db.runner, siteId);
      expect(key).toMatch(/^themes\/[0-9a-f]{64}\.css$/);
      expect(await cssOf(key)).toContain("Maple Sans");

      // A theme with only theme.json changes nothing in the look: in use, but no CSS file.
      await useTheme(db.runner, admin, siteId, other.theme.id);
      expect(await loadActiveThemeCssKey(db.runner, siteId)).toBeNull();
      const list = await listThemes(db.runner, siteId);
      expect(list.map((t) => [t.key, t.isActive])).toEqual([
        ["birch", true],
        ["maple", false],
      ]);

      await useTheme(db.runner, admin, siteId, null);
      expect((await listThemes(db.runner, siteId)).some((t) => t.isActive)).toBe(false);
    });

    test("an update keeps the old version; roll back restores it and rolling back again goes forward (TH-57)", async () => {
      const first = maple("1.0.0");
      const v1 = await installTheme(db.runner, storage, admin, siteId, first);
      if (!v1.ok) throw new Error(v1.message);
      await useTheme(db.runner, admin, siteId, v1.theme.id);
      const oldCss = await loadActiveThemeCssKey(db.runner, siteId);

      // The same package again changes nothing.
      const same = await installTheme(db.runner, storage, admin, siteId, first);
      expect(same).toMatchObject({ ok: true, change: "same" });

      const v2 = await installTheme(
        db.runner,
        storage,
        admin,
        siteId,
        maple("1.1.0", "body{background:url(assets/bg.png)} h1{letter-spacing:.02em}"),
      );
      if (!v2.ok) throw new Error(v2.message);
      expect(v2.change).toBe("update");
      expect(v2.theme).toMatchObject({
        id: v1.theme.id,
        version: "1.1.0",
        previousVersion: "1.0.0",
      });
      // The theme in use is updated at once: the site loads the new CSS.
      const newCss = await loadActiveThemeCssKey(db.runner, siteId);
      expect(newCss).not.toBe(oldCss);
      expect(await cssOf(newCss)).toContain("letter-spacing");

      const back = await rollBackTheme(db.runner, admin, siteId, v1.theme.id);
      expect(back).toMatchObject({
        ok: true,
        theme: { version: "1.0.0", previousVersion: "1.1.0" },
      });
      expect(await loadActiveThemeCssKey(db.runner, siteId)).toBe(oldCss);
      const forward = await rollBackTheme(db.runner, admin, siteId, v1.theme.id);
      expect(forward).toMatchObject({
        ok: true,
        theme: { version: "1.1.0", previousVersion: "1.0.0" },
      });
      expect(await loadActiveThemeCssKey(db.runner, siteId)).toBe(newCss);

      expect(await rollBackTheme(db.runner, editor, siteId, v1.theme.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      const birch = await installTheme(
        db.runner,
        storage,
        admin,
        siteId,
        tgz({ "theme.json": JSON.stringify({ key: "birch", name: "Birch", version: "1.0.0" }) }),
      );
      if (!birch.ok) throw new Error(birch.message);
      expect(await rollBackTheme(db.runner, admin, siteId, birch.theme.id)).toMatchObject({
        ok: false,
        code: "invalid",
      });
    });

    test("only two versions are kept; files no version uses any more are deleted, shared ones stay", async () => {
      const bg2 = Buffer.concat([png, Buffer.from("2")]);
      const bg3 = Buffer.concat([png, Buffer.from("3")]);
      await installTheme(db.runner, storage, admin, siteId, maple("1.0.0"));
      await installTheme(db.runner, storage, admin, siteId, maple("1.1.0", undefined, bg2));
      expect(await stored()).toContain(`${sha(png)}.png`);
      expect(await packages()).toHaveLength(2);
      await installTheme(db.runner, storage, admin, siteId, maple("1.2.0", undefined, bg3));
      const files = await stored();
      // 1.0.0 is gone with its own picture and package; the font, the same in every version, is kept once.
      expect(files).not.toContain(`${sha(png)}.png`);
      expect(files).toContain(`${sha(bg2)}.png`);
      expect(files).toContain(`${sha(bg3)}.png`);
      expect(files.filter((f) => f.endsWith(".woff2"))).toEqual([`${sha("wOF2 maple")}.woff2`]);
      expect(await packages()).toHaveLength(2);
    });

    test("a theme in use cannot be removed; removing another deletes its row and its files", async () => {
      const maple1 = await installTheme(db.runner, storage, admin, siteId, maple());
      if (!maple1.ok) throw new Error(maple1.message);
      await useTheme(db.runner, admin, siteId, maple1.theme.id);
      expect(await removeTheme(db.runner, storage, admin, siteId, maple1.theme.id)).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await removeTheme(db.runner, storage, editor, siteId, maple1.theme.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      await useTheme(db.runner, admin, siteId, null);
      expect(await removeTheme(db.runner, storage, admin, siteId, maple1.theme.id)).toEqual({
        ok: true,
      });
      expect(await listThemes(db.runner, siteId)).toEqual([]);
      expect(await stored()).toEqual([]);
      expect(await packages()).toEqual([]);
      expect(await removeTheme(db.runner, storage, admin, siteId, maple1.theme.id)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });

    test("a damaged row is left out, and its CSS is never loaded", async () => {
      const id = newId();
      await db.run(
        `insert into "themes" ("id", "site_id", "key", "version", "source", "is_active", "settings")
          values (?, ?, 'broken', '1.0.0', 'runtime', ?, ?)`,
        [
          id,
          siteId,
          true,
          JSON.stringify({ current: { version: "1.0.0", cssKey: "../../etc/passwd" } }),
        ],
      );
      expect(await listThemes(db.runner, siteId)).toEqual([]);
      expect(await loadActiveThemeCssKey(db.runner, siteId)).toBeNull();
    });
  });
}
