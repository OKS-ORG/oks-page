// The admin's brand color (spec 11, section 5.1; AG-40): ten very different colors each give a light and a dark scale that keep
// the admin readable, the style rules use oks-ui's own tokens, and a color that is not a color gives nothing.
import { describe, expect, test } from "vitest";
import { COLOR_STEPS, brandCss, brandScaleOk, brandScales, contrastRatio } from "./theme.js";

// The ten brand colors of the spec's test: a blue, a pure yellow, a neon green, white, black, a mid grey, an orange, a pink, a
// dark navy and a teal.
const COLORS = [
  "#3b82f6",
  "#ffff00",
  "#39ff14",
  "#ffffff",
  "#000000",
  "#808080",
  "#f97316",
  "#ec4899",
  "#0b1d3a",
  "#14b8a6",
];

describe("the two scales of one brand color", () => {
  test.each(COLORS)("%s gives a light and a dark scale that pass every contrast rule", (hex) => {
    const scales = brandScales(hex)!;
    expect(scales).not.toBeNull();
    for (const mode of ["light", "dark"] as const) {
      const s = scales[mode];
      expect(Object.keys(s).map(Number)).toEqual([...COLOR_STEPS]);
      for (const step of COLOR_STEPS)
        expect(s[step], `${hex} ${mode} ${step}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(brandScaleOk(s, mode), `${hex} ${mode}`).toBe(true);
      const text = mode === "light" ? "#ffffff" : "#000000";
      // The solid button, the soft button and the tabs (the rules of section 5.1), one by one.
      expect(contrastRatio(s[700], text), `${hex} ${mode} button text`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(s[700], s[100]), `${hex} ${mode} soft 700`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(s[800], s[100]), `${hex} ${mode} soft 800`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(s[600], s[50]), `${hex} ${mode} 600 on 50`).toBeGreaterThanOrEqual(3);
    }
  });

  test("the dark scale is not the light one: one scale in both modes fails", () => {
    const { light, dark } = brandScales("#3b82f6")!;
    expect(dark[700]).not.toBe(light[700]);
    // In light mode 700 is dark (white text on it); in dark mode it is light (black text on it).
    expect(contrastRatio(light[700], "#ffffff")).toBeGreaterThan(
      contrastRatio(light[700], "#000000"),
    );
    expect(contrastRatio(dark[700], "#000000")).toBeGreaterThan(
      contrastRatio(dark[700], "#ffffff"),
    );
    // Without the changes of section 5.1 a neon green fails: the plain scale's soft button text is too weak.
    const neon = brandScales("#39ff14")!;
    expect(brandScaleOk(neon.light, "light")).toBe(true);
  });

  test("a color that is not #rrggbb gives nothing", () => {
    for (const bad of ["red", "#12", "#gggggg", "", "rgb(1,2,3)", "javascript:alert(1)"]) {
      expect(brandScales(bad), bad).toBeNull();
      expect(brandCss(bad), bad).toBe("");
    }
    expect(brandScales("#ABC")).not.toBeNull();
  });
});

describe("the style rules", () => {
  test("the light scale for the page and the dark one under the dark theme, in oks-ui's own token names, and nothing else", () => {
    const css = brandCss("#1a5fb4");
    const [light, dark] = css.split("\n");
    expect(light!.startsWith(":root{")).toBe(true);
    expect(dark!.startsWith(':root[data-theme="dark"]{')).toBe(true);
    for (const step of COLOR_STEPS) {
      expect(light).toContain(`--oks-palette-primary-${step}:#`);
      expect(dark).toContain(`--oks-palette-primary-${step}:#`);
    }
    // Only colors in the rules: nothing that could end the style tag or add another rule.
    expect(css).not.toMatch(/[<>'\\]/);
    expect(css.replace(/--oks-palette-primary-\d+:#[0-9a-f]{6};/g, "")).toBe(
      ':root{}\n:root[data-theme="dark"]{}',
    );
  });
});
