import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { fontFaceCss, isOwnFont, ownFontFamily, ownFontStack, ownFontUrl } from "./font-library.js";
import {
  addOwnerFont,
  checkFontFile,
  deleteOwnerFont,
  loadOwnerFontFile,
  loadOwnerFonts,
  MAX_OWNER_FONT_BYTES,
  MAX_OWNER_FONTS,
  readOwnerFonts,
} from "./owner-fonts.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import { stylesToCss } from "./theme.js";
import { loadThemeCss, loadThemeStyles, saveThemeStyles } from "./theme-settings.js";

/** A file with the shape of a woff2 font (signature, length, tables); `seed` makes each one different. */
function woff2(seed = 0, length = 120, tables = 4): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x77, 0x4f, 0x46, 0x32]); // "wOF2"
  const view = new DataView(bytes.buffer);
  view.setUint32(8, length);
  view.setUint16(12, tables);
  view.setUint16(14, 0);
  view.setUint32(20, seed);
  return bytes;
}

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};
const input = (seed = 1, over: Record<string, unknown> = {}) => ({
  name: "Garden Sans",
  kind: "sans",
  weight: "400",
  licence: true,
  bytes: woff2(seed),
  ...over,
});

describe("the file check", () => {
  test("a woff2 file passes; other things are refused with a plain reason", () => {
    expect(checkFontFile(woff2())).toEqual({ ok: true });
    expect(checkFontFile(new Uint8Array(0))).toMatchObject({ ok: false });
    const text = new TextEncoder().encode("a".repeat(100));
    expect(checkFontFile(text)).toEqual({ ok: false, message: "This is not a .woff2 font file." });
    const wrongLength = woff2();
    new DataView(wrongLength.buffer).setUint32(8, 999);
    expect(checkFontFile(wrongLength)).toMatchObject({ ok: false, message: /damaged/ });
    expect(checkFontFile(woff2(0, 120, 0))).toMatchObject({ ok: false, message: /damaged/ });
    expect(checkFontFile(woff2(0, MAX_OWNER_FONT_BYTES + 1))).toMatchObject({
      ok: false,
      message: /too big/,
    });
    // An HTML or SVG file renamed to .woff2 is not a font.
    expect(
      checkFontFile(new TextEncoder().encode("<svg onload=alert(1)>".padEnd(80))),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe("an owner's font in the page code", () => {
  const key = "own-serif-vf-0123456789abcdef";
  test("the key says everything the page needs: the stack, the rule and the address", () => {
    expect(isOwnFont(key)).toBe(true);
    for (const bad of [
      "own-serif-400-0123",
      "own-sans-500-0123456789abcdef",
      'own-sans-400-0123456789abcde"',
      "inter",
      "own-sans-400-0123456789ABCDEF",
      3,
      null,
    ])
      expect(isOwnFont(bad), String(bad)).toBe(false);
    expect(ownFontStack(key)).toMatch(/^"oks-own-serif-vf-0123456789abcdef", .*serif/);
    expect(ownFontUrl(key)).toBe("/fonts/own-serif-vf-0123456789abcdef.woff2");
    expect(fontFaceCss([key, key, "own-sans-700-0123456789abcdef", "own-x"])).toBe(
      [
        `@font-face{font-family:"${ownFontFamily(key)}";font-style:normal;font-weight:100 900;font-display:swap;src:url(/fonts/${key}.woff2) format("woff2")}`,
        `@font-face{font-family:"oks-own-sans-700-0123456789abcdef";font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/own-sans-700-0123456789abcdef.woff2) format("woff2")}`,
      ].join("\n"),
    );
  });

  test("a look that uses it writes the rule and the variable; a damaged list is read as empty", () => {
    const css = stylesToCss({
      mainColor: null,
      logoMediaId: null,
      customCss: "",
      bodyFont: key,
      headingFont: "system-serif",
      colorMode: "light",
      modeSwitch: false,
    });
    expect(css).toContain(`font-family:"oks-${key}"`);
    expect(css).toContain(`--oks-site-font-body:"oks-${key}"`);
    expect(readOwnerFonts("not json")).toEqual([]);
    expect(readOwnerFonts([{ key: "own-sans-400-0123456789abcdef", name: 'x";}' }])).toEqual([]);
    expect(readOwnerFonts([{ key: "inter", name: "Inter" }])).toEqual([]);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the owner's own fonts`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;

    beforeEach(async () => {
      db = await open();
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
    });

    test("an administrator adds a font; it is listed, its file comes back by its fingerprint, and it is in the log", async () => {
      const added = await addOwnerFont(db.runner, admin, siteId, input(1));
      if (!added.ok) throw new Error(added.message);
      expect(added.font).toMatchObject({
        name: "Garden Sans",
        kind: "sans",
        weight: "400",
        bytes: 120,
      });
      expect(added.font.key).toMatch(/^own-sans-400-[0-9a-f]{16}$/);
      expect((await loadOwnerFonts(db.runner, siteId)).map((f) => f.key)).toEqual([added.font.key]);
      const sha16 = added.font.key.slice(-16);
      expect(await loadOwnerFontFile(db.runner, sha16)).toEqual(woff2(1));
      expect(await loadOwnerFontFile(db.runner, "0".repeat(16))).toBeNull();
      expect(await loadOwnerFontFile(db.runner, "not a fingerprint")).toBeNull();
      const log = await db.runner.all(
        `select "action", "target_id", "detail" from "audit_log" where "action" like 'font.%'`,
      );
      expect(log.map((r) => r["action"])).toEqual(["font.add"]);
      expect(log[0]!["target_id"]).toBe(added.font.key);
    });

    test("only a person who manages the design may add one, and the owner's word about the licence is needed", async () => {
      expect(await addOwnerFont(db.runner, editor, siteId, input(1))).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(
        await addOwnerFont(db.runner, admin, siteId, input(1, { licence: false })),
      ).toMatchObject({ ok: false, code: "invalid", field: "licence" });
      expect(await loadOwnerFonts(db.runner, siteId)).toEqual([]);
    });

    test("a bad name, kind, weight or file is refused with the field named; nothing is kept", async () => {
      for (const [over, field] of [
        [{ name: "" }, "name"],
        [{ name: 'a";}body{' }, "name"],
        [{ name: "x".repeat(41) }, "name"],
        [{ kind: "comic" }, "kind"],
        [{ weight: "500" }, "weight"],
        [{ bytes: new TextEncoder().encode("not a font at all".padEnd(100)) }, "file"],
      ] as const)
        expect(await addOwnerFont(db.runner, admin, siteId, input(1, over))).toMatchObject({
          ok: false,
          code: "invalid",
          field,
        });
      expect(await loadOwnerFonts(db.runner, siteId)).toEqual([]);
      const files = await db.runner.all(
        `select "key" from "settings" where "key" like 'owner-font-file:%'`,
      );
      expect(files).toEqual([]);
    });

    test("the same file twice is refused, and a site keeps only a few fonts", async () => {
      expect((await addOwnerFont(db.runner, admin, siteId, input(1))).ok).toBe(true);
      expect(await addOwnerFont(db.runner, admin, siteId, input(1))).toMatchObject({
        ok: false,
        field: "file",
        message: "This font file is already added.",
      });
      for (let seed = 2; seed <= MAX_OWNER_FONTS; seed++)
        expect((await addOwnerFont(db.runner, admin, siteId, input(seed))).ok).toBe(true);
      expect(
        await addOwnerFont(db.runner, admin, siteId, input(MAX_OWNER_FONTS + 1)),
      ).toMatchObject({ ok: false, field: "file", message: /Remove one first/ });
    });

    test("the look can choose it only while the site has it; the page then carries its rule; it cannot be removed while used", async () => {
      const added = await addOwnerFont(db.runner, admin, siteId, input(1));
      if (!added.ok) throw new Error(added.message);
      const key = added.font.key;
      // A key that was never added is refused.
      expect(
        await saveThemeStyles(db.runner, admin, siteId, {
          bodyFont: "own-sans-400-aaaaaaaaaaaaaaaa",
        }),
      ).toMatchObject({ ok: false, field: "bodyFont" });
      expect(await saveThemeStyles(db.runner, admin, siteId, { bodyFont: key })).toMatchObject({
        ok: true,
      });
      const css = await loadThemeCss(db.runner, siteId);
      expect(css).toContain(`@font-face{font-family:"oks-${key}"`);
      expect(css).toContain(`src:url(/fonts/${key}.woff2)`);
      expect(css).toContain(`--oks-site-font-body:"oks-${key}"`);
      // In use: refused, and nothing is lost.
      expect(await deleteOwnerFont(db.runner, admin, siteId, key)).toMatchObject({
        ok: false,
        code: "in_use",
        message: /Garden Sans is used by your site/,
      });
      expect(await loadOwnerFontFile(db.runner, key.slice(-16))).not.toBeNull();
      // Not in use any more: removed, with its file, and the log says so.
      await saveThemeStyles(db.runner, admin, siteId, { bodyFont: "system-serif" });
      expect(await deleteOwnerFont(db.runner, editor, siteId, key)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await deleteOwnerFont(db.runner, admin, siteId, key)).toMatchObject({ ok: true });
      expect(await loadOwnerFonts(db.runner, siteId)).toEqual([]);
      expect(await loadOwnerFontFile(db.runner, key.slice(-16))).toBeNull();
      expect(await deleteOwnerFont(db.runner, admin, siteId, key)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      const log = await db.runner.all(
        `select "action" from "audit_log" where "action" like 'font.%' order by "created_at", "id"`,
      );
      expect(log.map((r) => r["action"]).sort()).toEqual(["font.add", "font.remove"]);
      expect((await loadThemeStyles(db.runner, siteId)).bodyFont).toBe("system-serif");
    });
  });
}
