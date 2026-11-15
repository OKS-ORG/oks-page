// The look of a site as data (spec 05, sections 4 and 5). A look is a set of tokens: colors, corner radius and fonts. The
// core checks every value and writes the CSS itself, so nothing an author or an owner types can reach the style sheet as
// code. The owner's simple controls (one main color, two fonts) and, later, a theme package's `theme.json` both end here.
// This file knows nothing about databases; it is pure.
import { checkThemeCss } from "./css-check.js";
import { fontByKey, fontFaceCss, libraryStack } from "./font-library.js";

export * from "./font-library.js";

/** The 11 steps of every color role in oks-ui (`--oks-color-<role>-<step>`). */
export const COLOR_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export const COLOR_ROLES = [
  "primary",
  "secondary",
  "success",
  "warning",
  "danger",
  "info",
  "neutral",
  "default",
] as const;
/** Other color names a look may set. The first three are oks-ui's, the last three are the site's own. */
export const COLOR_SINGLES = [
  "surface",
  "border",
  "fg-muted",
  "text",
  "background",
  "link",
] as const;
export const RADIUS_NAMES = ["none", "xs", "sm", "md", "lg", "xl", "2xl", "full"] as const;

/** Fonts that need no download: the visitor's own system fonts. */
export const FONT_STACKS = {
  "system-sans":
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "system-serif":
    '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
  "system-mono": 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;
export type FontChoice = keyof typeof FONT_STACKS;
export const FONT_CHOICES = Object.keys(FONT_STACKS) as FontChoice[];

export interface ThemeTokens {
  /** Keys: `<role>-<step>` (primary-700), or one of `COLOR_SINGLES`. */
  color?: Record<string, string>;
  /** Keys: `RADIUS_NAMES`. */
  radius?: Record<string, string>;
  /** Keys: `body`, `heading`. A value is one of `FONT_CHOICES` or a plain font name. */
  font?: Record<string, string>;
  /** Values for dark mode (`data-theme="dark"`). */
  dark?: { color?: Record<string, string> };
}

// ---------------------------------------------------------------------------------------------------------------------
// Checking values
// ---------------------------------------------------------------------------------------------------------------------

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = new RegExp(
  String.raw`^rgba?\(\s*${NUM}%?\s*[, ]\s*${NUM}%?\s*[, ]\s*${NUM}%?\s*(?:[,/]\s*${NUM}%?\s*)?\)$`,
  "i",
);
const HSL = new RegExp(
  String.raw`^hsla?\(\s*${NUM}(?:deg)?\s*[, ]\s*${NUM}%\s*[, ]\s*${NUM}%\s*(?:[,/]\s*${NUM}%?\s*)?\)$`,
  "i",
);
const LENGTH = /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/;
const FONT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,59}$/u;

/** A color is a hex value, `rgb()`/`rgba()` or `hsl()`/`hsla()` with plain numbers. Named colors are not accepted yet. */
export const isColor = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 60 &&
  (HEX.test(value) || RGB.test(value) || HSL.test(value));
export const isLength = (value: unknown): value is string =>
  typeof value === "string" && LENGTH.test(value);
export const isFontName = (value: unknown): value is string =>
  typeof value === "string" && FONT_NAME.test(value);

const COLOR_KEYS: ReadonlySet<string> = new Set([
  ...COLOR_ROLES.flatMap((role) => COLOR_STEPS.map((step) => `${role}-${step}`)),
  ...COLOR_SINGLES,
]);
const RADIUS_KEYS: ReadonlySet<string> = new Set(RADIUS_NAMES);
const FONT_KEYS: ReadonlySet<string> = new Set(["body", "heading"]);

export type TokenCheck = { ok: true; tokens: ThemeTokens } | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks tokens from anywhere (the owner's controls, a theme package). An unknown name or a value that is not plain is an
 * error and nothing from that input is used. Nothing is repaired: a refused value stays refused.
 */
export function checkTokens(input: unknown): TokenCheck {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["The design values were not understood."] };
  const tokens: ThemeTokens = {};

  const group = (
    name: string,
    value: unknown,
    known: ReadonlySet<string>,
    valid: (v: unknown) => boolean,
    what: string,
  ): Record<string, string> | undefined => {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
      errors.push(`"${name}" was not understood.`);
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(value)) {
      if (!known.has(key)) errors.push(`"${name}.${key}" is not a name that can be set.`);
      else if (!valid(v)) errors.push(`"${name}.${key}" is not ${what}.`);
      else out[key] = v as string;
    }
    return out;
  };
  const fontOk = (v: unknown) => (typeof v === "string" && v in FONT_STACKS) || isFontName(v);

  const color = group("color", input["color"], COLOR_KEYS, isColor, "a color");
  const radius = group(
    "radius",
    input["radius"],
    RADIUS_KEYS,
    isLength,
    "a length such as 8px or 0.5rem",
  );
  const font = group("font", input["font"], FONT_KEYS, fontOk, "a plain font name");
  if (color) tokens.color = color;
  if (radius) tokens.radius = radius;
  if (font) tokens.font = font;

  const dark = input["dark"];
  if (dark !== undefined) {
    if (!isRecord(dark)) errors.push('"dark" was not understood.');
    else {
      for (const key of Object.keys(dark))
        if (key !== "color") errors.push(`"dark.${key}" is not a name that can be set.`);
      const darkColor = group("dark.color", dark["color"], COLOR_KEYS, isColor, "a color");
      if (darkColor) tokens.dark = { color: darkColor };
    }
  }
  for (const key of Object.keys(input))
    if (!["color", "radius", "font", "dark"].includes(key))
      errors.push(`"${key}" is not a name that can be set.`);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, tokens };
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing the CSS
// ---------------------------------------------------------------------------------------------------------------------

/** The CSS font-family value of a font token. */
export const fontStack = (value: string): string => {
  if (value in FONT_STACKS) return FONT_STACKS[value as FontChoice];
  const library = fontByKey(value);
  return library ? libraryStack(library) : `"${value}", system-ui, sans-serif`;
};

/** The CSS variable a color key becomes. */
function colorVariable(key: string): string {
  if (key === "text" || key === "background" || key === "link") return `--oks-site-${key}`;
  return `--oks-color-${key}`;
}

const declarations = (pairs: [string, string][]): string =>
  pairs.map(([n, v]) => `${n}:${v}`).join(";");

/**
 * Writes the CSS for checked tokens: the variables on `:root`, the dark values on `:root[data-theme="dark"]`, and the few
 * rules that make the page use them. Returns an empty string when there is nothing to say, so a site with no look set
 * is exactly as before.
 */
export function tokensToCss(tokens: ThemeTokens): string {
  const light: [string, string][] = [];
  for (const [key, value] of Object.entries(tokens.color ?? {}))
    light.push([colorVariable(key), value]);
  for (const [key, value] of Object.entries(tokens.radius ?? {}))
    light.push([`--oks-radius-${key}`, value]);
  for (const [key, value] of Object.entries(tokens.font ?? {}))
    light.push([`--oks-site-font-${key}`, fontStack(value)]);
  const dark: [string, string][] = Object.entries(tokens.dark?.color ?? {}).map(([k, v]) => [
    colorVariable(k),
    v,
  ]);

  const has = (name: string) => light.some(([n]) => n === name) || dark.some(([n]) => n === name);
  const rules: string[] = [];
  if (light.length > 0) rules.push(`:root{${declarations(light)}}`);
  if (dark.length > 0) rules.push(`:root[data-theme="dark"]{${declarations(dark)}}`);

  const body: [string, string][] = [];
  if (has("--oks-site-font-body")) body.push(["font-family", "var(--oks-site-font-body)"]);
  if (has("--oks-site-text")) body.push(["color", "var(--oks-site-text)"]);
  if (has("--oks-site-background")) body.push(["background-color", "var(--oks-site-background)"]);
  if (body.length > 0) rules.push(`body{${declarations(body)}}`);
  if (has("--oks-site-font-heading"))
    rules.push("h1,h2,h3,h4,h5,h6{font-family:var(--oks-site-font-heading)}");
  if (has("--oks-site-link")) rules.push("a{color:var(--oks-site-link)}");
  else if (has("--oks-color-primary-700")) rules.push("a{color:var(--oks-color-primary-700)}");
  return rules.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// One color to a whole scale
// ---------------------------------------------------------------------------------------------------------------------

type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** "#rrggbb" (or "#rgb") to red, green and blue between 0 and 1; null when it is not one. */
export function parseHex(hex: string): Rgb | null {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) return [short[1]!, short[2]!, short[3]!].map((d) => parseInt(d + d, 16) / 255) as Rgb;
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!long) return null;
  return [long[1]!, long[2]!, long[3]!].map((d) => parseInt(d, 16) / 255) as Rgb;
}

const hexOf = (rgb: Rgb): string =>
  "#" +
  rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

/** Contrast between two "#rrggbb" colors, from 1 to 21 (WCAG). */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const rgb = parseHex(hex) ?? [0, 0, 0];
    const [r, g, bl] = rgb.map(toLinear) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function toOklch([r, g, b]: Rgb): { L: number; C: number; h: number } {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

/** The color for a lightness, a chroma and a hue; the chroma is lowered until the color fits the screen. */
function fromOklch(L: number, C: number, h: number): string {
  const make = (chroma: number): { rgb: Rgb; inside: boolean } => {
    const a = chroma * Math.cos(h);
    const b = chroma * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin: Rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    const eps = 1e-4;
    return {
      rgb: lin.map((c) => fromLinear(Math.min(1, Math.max(0, c)))) as Rgb,
      inside: lin.every((c) => c >= -eps && c <= 1 + eps),
    };
  };
  let lo = 0;
  let hi = C;
  if (make(hi).inside) return hexOf(make(hi).rgb);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (make(mid).inside) lo = mid;
    else hi = mid;
  }
  return hexOf(make(lo).rgb);
}

// Lightness of each step, light mode. Step 700 is the solid button color: white text on it reaches about 6.5:1.
const LIGHTNESS = [0.97, 0.94, 0.88, 0.8, 0.71, 0.63, 0.55, 0.48, 0.41, 0.34, 0.26];
// How much of the chroma each step keeps: the very light and very dark steps are calmer.
const CHROMA = [0.2, 0.35, 0.55, 0.78, 0.95, 1, 1, 0.95, 0.85, 0.7, 0.55];

/** A scale of 11 steps from one color (spec 05, section 4.3). Returns null when the color is not "#rrggbb". */
export function colorScale(
  hex: string,
  mode: "light" | "dark" = "light",
): Record<(typeof COLOR_STEPS)[number], string> | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const { C, h } = toOklch(rgb);
  const out = {} as Record<(typeof COLOR_STEPS)[number], string>;
  COLOR_STEPS.forEach((step, i) => {
    // In dark mode the scale runs the other way, so a solid button (step 700) is light and takes dark text.
    const at = mode === "light" ? i : COLOR_STEPS.length - 1 - i;
    out[step] = fromOklch(LIGHTNESS[at]!, C * CHROMA[at]!, h);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The owner's simple controls
// ---------------------------------------------------------------------------------------------------------------------

export interface ThemeStyles {
  /** One main color as "#rrggbb", or null for the built-in look. */
  mainColor: string | null;
  /** The id of the logo in the media library, or null for no logo. */
  logoMediaId: string | null;
  /** The developer's own CSS (already checked and without comments), or an empty text. Written after the look. */
  customCss: string;
  /** A system font ("system-sans") or a font of the built-in library ("inter"). */
  bodyFont: string;
  headingFont: string;
}

export const DEFAULT_THEME_STYLES: ThemeStyles = {
  mainColor: null,
  logoMediaId: null,
  customCss: "",
  bodyFont: "system-sans",
  headingFont: "system-sans",
};

/** The tokens the owner's controls mean. */
export function stylesToTokens(styles: ThemeStyles): ThemeTokens {
  const tokens: ThemeTokens = {};
  const color: Record<string, string> = {};
  const dark: Record<string, string> = {};
  if (styles.mainColor) {
    const light = colorScale(styles.mainColor, "light");
    const night = colorScale(styles.mainColor, "dark");
    if (light && night)
      for (const step of COLOR_STEPS) {
        color[`primary-${step}`] = light[step];
        dark[`primary-${step}`] = night[step];
      }
  }
  if (Object.keys(color).length > 0) {
    tokens.color = color;
    tokens.dark = { color: dark };
  }
  if (
    styles.bodyFont !== DEFAULT_THEME_STYLES.bodyFont ||
    styles.headingFont !== DEFAULT_THEME_STYLES.headingFont
  )
    tokens.font = { body: styles.bodyFont, heading: styles.headingFont };
  return tokens;
}

/** The CSS for the owner's controls; empty when everything is still the built-in look. */
export function stylesToCss(styles: ThemeStyles): string {
  const checked = checkTokens(stylesToTokens(styles));
  // The `@font-face` rules of the library fonts in use come first; they are written from the list, never from text.
  const faces = fontFaceCss([styles.bodyFont, styles.headingFont]);
  const colors = checked.ok ? tokensToCss(checked.tokens) : "";
  const look = faces ? (colors ? `${faces}\n${colors}` : faces) : colors;
  // The custom CSS is checked again here, so only checked text is ever written, whatever was stored.
  const custom = styles.customCss ? checkThemeCss(styles.customCss) : null;
  return custom?.ok && custom.css ? (look ? `${look}\n${custom.css}` : custom.css) : look;
}
