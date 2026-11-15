import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FONT_FILES } from "./font-files.js";
import {
  FONT_LIBRARY,
  fontByKey,
  fontFaceCss,
  fontFileByName,
  fontFileName,
  fontFileUrl,
} from "./font-library.js";
import { readThemeStyles } from "./theme-settings.js";
import { DEFAULT_THEME_STYLES, fontStack, stylesToCss } from "./theme.js";

describe("the font library (ADR 0028)", () => {
  test("the list: 12 fonts, all under the SIL Open Font Licence, each with a notice (FL-11)", () => {
    expect(FONT_LIBRARY).toHaveLength(12);
    for (const font of FONT_LIBRARY) {
      expect(font.license).toBe("OFL-1.1");
      expect(font.key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(font.copyright.length).toBeGreaterThan(5);
      expect(font.integrity).toMatch(/^sha512-/);
      expect(font.files.length).toBeGreaterThan(0);
    }
    // The families the founder's list names for the bundled set, Hindi included.
    expect(FONT_LIBRARY.map((f) => f.name)).toEqual(
      expect.arrayContaining(["Inter", "Roboto", "Open Sans", "JetBrains Mono", "Hind"]),
    );
    expect(fontByKey("noto-sans-devanagari")?.scripts).toEqual(["latin", "devanagari"]);
  });

  test("every file works with no network: the bytes are in the package and match their fingerprint (FL-09)", () => {
    let total = 0;
    for (const font of FONT_LIBRARY)
      for (const file of font.files) {
        const encoded = FONT_FILES[file.sha256];
        expect(encoded, `${font.key} ${file.script} ${file.weight}`).toBeTruthy();
        const bytes = Buffer.from(encoded!, "base64");
        expect(bytes.length).toBe(file.bytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
        expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
        total += bytes.length;
      }
    // About 0.9 MB for the whole starter set (ADR 0028 measured 0.8 MB for its list).
    expect(total).toBeLessThan(1_100_000);
  });

  test("an address means exactly one file; any other name is refused", () => {
    const font = fontByKey("inter")!;
    const file = font.files.find((f) => f.script === "latin" && f.weight === 400)!;
    const name = fontFileName(font, file);
    expect(name).toMatch(/^inter-latin-400\.[0-9a-f]{16}\.woff2$/);
    expect(fontFileUrl(font, file)).toBe(`/fonts/${name}`);
    expect(fontFileByName(name)).toMatchObject({
      font: { key: "inter" },
      file: { sha256: file.sha256 },
    });
    for (const bad of [
      "inter-latin-400.0000000000000000.woff2",
      "inter-latin-400.woff2",
      "inter-greek-400.0123456789abcdef.woff2",
      "../inter-latin-400.0123456789abcdef.woff2",
      "nothing-latin-400.0123456789abcdef.woff2",
      "inter-latin-400." + file.sha256.slice(0, 16) + ".woff",
    ])
      expect(fontFileByName(bad), bad).toBeNull();
  });

  test("the CSS: rules only for library fonts, once each, from the site itself, with swap", () => {
    expect(fontFaceCss(["system-sans", 'evil"; } body { x: y', "unknown"])).toBe("");
    const css = fontFaceCss(["inter", "inter", "hind"]);
    // Inter: latin 400 and 700. Hind: latin and Devanagari at 400 and 700.
    expect(css.match(/@font-face/g)).toHaveLength(6);
    expect(css).toContain('font-family:"Inter"');
    expect(css).toContain("font-display:swap");
    expect(css).toContain("unicode-range:U+0900-097F");
    expect(css).not.toMatch(/https?:/);
    expect(fontStack("inter")).toMatch(/^"Inter", system-ui/);
    expect(fontStack("source-serif-4")).toMatch(/^"Source Serif 4", "Iowan Old Style"/);
    expect(fontStack("jetbrains-mono")).toMatch(/^"JetBrains Mono", ui-monospace/);
    expect(fontStack("system-serif")).toContain("Georgia");
  });

  test("the owner's look: a chosen library font writes its rules, and an unknown value is ignored when read", () => {
    const styles = { ...DEFAULT_THEME_STYLES, bodyFont: "inter", headingFont: "source-serif-4" };
    const css = stylesToCss(styles);
    expect(css).toContain("@font-face");
    expect(css).toContain('--oks-site-font-body:"Inter", system-ui');
    expect(css).toContain('--oks-site-font-heading:"Source Serif 4"');
    expect(stylesToCss({ ...DEFAULT_THEME_STYLES, colorMode: "light", modeSwitch: false })).toBe(
      "",
    );
    expect(readThemeStyles({ bodyFont: "inter", headingFont: "system-mono" })).toMatchObject({
      bodyFont: "inter",
      headingFont: "system-mono",
    });
    expect(readThemeStyles({ bodyFont: "comic-sans", headingFont: 5 })).toMatchObject({
      bodyFont: "system-sans",
      headingFont: "system-sans",
    });
  });
});
