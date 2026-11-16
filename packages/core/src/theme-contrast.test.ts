import { describe, expect, test } from "vitest";
import { contrastWarnings } from "./theme-contrast.js";
import type { ThemeTokens } from "./theme.js";

const both = { colorMode: "system" as const };

describe("contrast of a look (TH-52)", () => {
  test("a site with no theme colors has nothing to report", () => {
    expect(contrastWarnings(null, { mainColor: null, ...both })).toEqual([]);
  });

  test("the owner's main color never gives a warning, in light or dark", () => {
    for (const color of ["#2a6f4f", "#f5d90a", "#ff0000", "#3b82f6", "#111111", "#fafafa"])
      expect(contrastWarnings(null, { mainColor: color, ...both }), color).toEqual([]);
  });

  test("a theme's light-only text color is reported in dark mode, in plain words", () => {
    const theme: ThemeTokens = { color: { text: "#222222", background: "#ffffff" } };
    // The page background stays white in dark mode here, so the dark text is fine; the trouble is when only the text
    // is set and the dark page stays dark.
    const textOnly: ThemeTokens = { color: { text: "#222222" } };
    expect(contrastWarnings(theme, both)).toEqual([]);
    const found = contrastWarnings(textOnly, both);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ mode: "dark", part: "text" });
    expect(found[0]!.ratio).toBeLessThan(4.5);
    expect(found[0]!.message).toMatch(
      /^In dark mode the text is hard to read \(contrast \d\.\d to 1; it needs 4\.5 to 1\)\.$/,
    );
  });

  test("the theme's own dark values fix it", () => {
    const theme: ThemeTokens = {
      color: { text: "#222222" },
      dark: { color: { text: "#eeeeee" } },
    };
    expect(contrastWarnings(theme, both)).toEqual([]);
  });

  test("grey text on white is reported in light mode (2.8 to 1)", () => {
    const found = contrastWarnings(
      { color: { "fg-muted": "#999999" } },
      { mainColor: null, colorMode: "light" },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ mode: "light", part: "muted", ratio: 2.8 });
  });

  test("a light main color reused in dark mode is reported for the button text", () => {
    const theme: ThemeTokens = { color: { "primary-700": "#60a5fa" } };
    const found = contrastWarnings(theme, both);
    // White text on #60a5fa is weak in light mode; in dark mode black text on it passes.
    expect(found.map((w) => `${w.mode}:${w.part}`)).toContain("light:button");
    expect(found.map((w) => `${w.mode}:${w.part}`)).not.toContain("dark:button");
  });

  test("only the modes a visitor can reach are checked", () => {
    const theme: ThemeTokens = { color: { text: "#222222" } };
    expect(contrastWarnings(theme, { mainColor: null, colorMode: "light" })).toEqual([]);
    expect(contrastWarnings(theme, { mainColor: null, colorMode: "dark" })).toHaveLength(1);
  });

  test("colors written another way (rgb) are left out, not guessed", () => {
    expect(contrastWarnings({ color: { text: "rgb(34, 34, 34)" } }, both)).toEqual([]);
  });

  test("the ratio is never rounded up to the limit", () => {
    // #767676 on white is 4.54; #777777 is 4.48 and must show as 4.4, not 4.5.
    const found = contrastWarnings(
      { color: { "fg-muted": "#777777" } },
      { mainColor: null, colorMode: "light" },
    );
    expect(found[0]!.ratio).toBe(4.4);
  });
});
