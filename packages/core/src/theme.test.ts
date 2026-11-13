import { describe, expect, test } from "vitest";
import {
  COLOR_STEPS,
  checkTokens,
  colorScale,
  contrastRatio,
  isColor,
  stylesToCss,
  tokensToCss,
  type ThemeStyles,
} from "./theme.js";

const styles = (over: Partial<ThemeStyles> = {}): ThemeStyles => ({
  mainColor: null,
  logoMediaId: null,
  bodyFont: "system-sans",
  headingFont: "system-sans",
  ...over,
});

describe("colors", () => {
  test("accepts plain colors and refuses everything that is not", () => {
    for (const ok of [
      "#fff",
      "#2A6F4F",
      "#2a6f4f80",
      "rgb(1, 2, 3)",
      "rgba(1,2,3,0.5)",
      "hsl(120, 40%, 30%)",
    ])
      expect(isColor(ok), ok).toBe(true);
    for (const bad of [
      "red;}body{display:none",
      "url(javascript:alert(1))",
      "</style><script>x</script>",
      "expression(alert(1))",
      "red !important;--x:1",
      "#12",
      "rgb(1,2,3);color:red",
      "var(--x)",
      "",
      42,
      null,
    ])
      expect(isColor(bad), String(bad)).toBe(false);
  });
});

describe("the scale made from one color", () => {
  test("has 11 steps in order from light to dark", () => {
    const scale = colorScale("#2a6f4f")!;
    expect(Object.keys(scale)).toEqual(COLOR_STEPS.map(String));
    const lightness = COLOR_STEPS.map((s) => contrastRatio(scale[s], "#000000"));
    expect([...lightness].sort((a, b) => b - a)).toEqual(lightness);
  });

  test("white text on step 700 reaches 4.5:1 for every hue, and dark mode takes black text", () => {
    for (let hue = 0; hue < 360; hue += 10) {
      const hsl = `hsl(${hue}, 80%, 50%)`;
      // Turn the hue into a hex color through a plain table of six-digit values.
      const seed = hexFromHue(hue);
      const light = colorScale(seed, "light")!;
      const dark = colorScale(seed, "dark")!;
      expect(contrastRatio(light[700], "#ffffff"), `${hsl} light`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(dark[700], "#000000"), `${hsl} dark`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("handles greys, white, black and bright yellow without breaking", () => {
    for (const seed of ["#808080", "#ffffff", "#000000", "#ffff00", "#00ffff"]) {
      const scale = colorScale(seed)!;
      for (const step of COLOR_STEPS) expect(scale[step]).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastRatio(scale[700], "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("is null for something that is not a six-digit color", () => {
    expect(colorScale("green")).toBeNull();
    expect(colorScale("#12345")).toBeNull();
  });
});

describe("checking tokens", () => {
  test("accepts known names with plain values", () => {
    const result = checkTokens({
      color: { "primary-700": "#2a6f4f", text: "#222222", link: "rgb(0, 80, 160)" },
      radius: { md: "8px", full: "9999px", none: "0" },
      font: { body: "system-serif", heading: "Source Serif 4" },
      dark: { color: { "primary-700": "#a7d8bf" } },
    });
    expect(result.ok).toBe(true);
  });

  test("refuses unknown names, hostile values and wrong shapes, and uses nothing from them", () => {
    const hostile = [
      { color: { "primary-700": "red;}body{display:none" } },
      { color: { "primary-701": "#ffffff" } },
      { color: { "--x": "#ffffff" } },
      { color: { text: "url(https://evil.example/x)" } },
      { radius: { md: "8px;position:fixed" } },
      { radius: { huge: "8px" } },
      { font: { body: 'Evil"; } body { display: none' } },
      { font: { body: "</style><script>x</script>" } },
      { font: { mono: "Fira Code" } },
      { dark: { radius: { md: "1px" } } },
      { dark: "yes" },
      { css: "body{}" },
      { color: "#ffffff" },
      [],
      null,
      "text",
    ];
    for (const input of hostile) {
      const result = checkTokens(input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
      if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("the CSS that is written", () => {
  test("is empty when nothing is set", () => {
    expect(tokensToCss({})).toBe("");
    expect(stylesToCss(styles())).toBe("");
  });

  test("holds the variables, the dark values and the rules that use them", () => {
    const css = stylesToCss(
      styles({ mainColor: "#2a6f4f", bodyFont: "system-serif", headingFont: "system-mono" }),
    );
    expect(css).toContain(":root{--oks-color-primary-50:");
    expect(css).toContain("--oks-color-primary-950:");
    expect(css).toContain(':root[data-theme="dark"]{--oks-color-primary-50:');
    expect(css).toContain("--oks-site-font-body:");
    expect(css).toContain("--oks-site-font-heading:");
    expect(css).toContain("body{font-family:var(--oks-site-font-body)}");
    expect(css).toContain("h1,h2,h3,h4,h5,h6{font-family:var(--oks-site-font-heading)}");
    expect(css).toContain("a{color:var(--oks-color-primary-700)}");
  });

  test("a plain font name becomes a quoted family with a fallback", () => {
    const css = tokensToCss({ font: { body: "Source Serif 4" } });
    expect(css).toContain('--oks-site-font-body:"Source Serif 4", system-ui, sans-serif');
  });

  test("never holds anything but the checked values", () => {
    const css = stylesToCss(styles({ mainColor: "#2A6F4F" }));
    expect(css).not.toMatch(/[<>]|url\(|@import|expression|javascript:/i);
    expect(css).toMatch(/^[\n\r\x20-\x7e]*$/);
  });
});

/** A fully bright color of a hue, as "#rrggbb". */
function hexFromHue(hue: number): string {
  const f = (n: number) => {
    const k = (n + hue / 60) % 6;
    const v = 1 - Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}
