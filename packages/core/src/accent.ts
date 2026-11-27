// The accent colour of the admin (the new look, docs/18-new-look.md). A person picks one colour; everything else that depends
// on it is worked out here: the pale tint of a selected item, the text on it, the hover shade, the focus ring, the shade
// scale oks-ui wants. If the colour is too pale (or too dark, in dark mode) for text to stay readable, it is moved just
// far enough and the result says so, so the screen can tell the person. Pure code: no browser, no database.

export type Rgb = readonly [number, number, number];

const HEX = /^#?([0-9a-f]{6})$/i;

/** "#0b57d0" (or "0b57d0") as red, green and blue, or null when it is not a six-digit colour. */
export function parseColour(hex: string): Rgb | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: Rgb): string {
  return (
    "#" +
    rgb
      .map((v) =>
        Math.round(Math.min(255, Math.max(0, v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/** Relative luminance (WCAG 2.2). */
export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio of two colours, 1 to 21 (WCAG 2.2). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `t` of the way from `a` to `b` (0 is a, 1 is b). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** Text on an accent colour: white or near-black, whichever reads better. */
export function onColour(accent: Rgb): Rgb {
  const dark: Rgb = [20, 22, 26];
  return contrast(accent, WHITE) >= contrast(accent, dark) ? WHITE : dark;
}

/** Moves `colour` towards `toward` in small steps until it has `min` contrast with `against`; stops after 40 steps. */
function nudge(colour: Rgb, against: Rgb, toward: Rgb, min: number): Rgb {
  // Each step is rounded to whole numbers, so the contrast measured is the contrast of the colour that is written out.
  const whole = (c: Rgb): Rgb => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
  let out = whole(colour);
  for (let i = 1; i <= 40 && contrast(out, against) < min; i++)
    out = whole(mix(colour, toward, i / 40));
  return out;
}

export interface AccentTokens {
  /** The accent used for buttons and focus: the person's colour, or the nearest readable one. */
  accent: string;
  /** Text on the accent (a button label). */
  on: string;
  /** The pale fill of a selected menu item or chip. */
  sel: string;
  /** Accent-coloured text on that fill, and on the card (links, the selected item). */
  selText: string;
  /** The accent a little darker (light mode) or lighter (dark mode), for hover. */
  hover: string;
  /** The same accent as it was typed. */
  original: string;
  /** True when the colour had to move to stay readable. */
  adjusted: boolean;
  /** What the person typed gave this contrast with its text; after the move it is at least 4.5. */
  contrastBefore: number;
  contrastAfter: number;
}

export interface AccentSurfaces {
  /** The card colour (the surface the accent text sits on). */
  card: string;
  /** The page ground. */
  ground: string;
  dark: boolean;
}

/**
 * The tokens for one accent on one set of surfaces. Light mode: the accent must carry its label at 4.5:1 and be readable as
 * text on the card, so too pale a colour is darkened. Dark mode: the accent is the light one on the dark card, so too dark a
 * colour is lightened; its label is then near-black.
 */
export function deriveAccent(typed: string, surfaces: AccentSurfaces): AccentTokens | null {
  const original = parseColour(typed);
  const card = parseColour(surfaces.card);
  const ground = parseColour(surfaces.ground);
  if (!original || !card || !ground) return null;
  const MIN = 4.5;
  // The weaker of the two readings that matter: the accent as text on the card, and the label on the accent.
  const contrastOf = (c: Rgb) => Math.min(contrast(c, card), contrast(onColour(c), c));
  const before = contrastOf(original);
  // Dark mode: a light accent on a dark card, so lighten until it reads on the card and carries a dark label.
  // Light mode: a dark accent on a light card, so darken until it reads on the card and carries a white label.
  const onCard = nudge(original, card, surfaces.dark ? WHITE : BLACK, MIN);
  const accent =
    surfaces.dark || contrast(onCard, WHITE) >= MIN ? onCard : nudge(onCard, WHITE, BLACK, MIN);
  const on = onColour(accent);
  const sel = mix(ground, accent, surfaces.dark ? 0.22 : 0.16);
  const selText = surfaces.dark ? nudge(accent, sel, WHITE, MIN) : nudge(accent, sel, BLACK, MIN);
  const hover = mix(accent, surfaces.dark ? WHITE : BLACK, 0.12);
  return {
    accent: toHex(accent),
    on: toHex(on),
    sel: toHex(sel),
    selText: toHex(selText),
    hover: toHex(hover),
    original: toHex(original),
    adjusted: toHex(accent) !== toHex(original),
    contrastBefore: Math.round(before * 100) / 100,
    contrastAfter: Math.round(contrastOf(accent) * 100) / 100,
  };
}

/** The eleven shades oks-ui uses (its `--oks-color-primary-50` to `-950`), from the accent. */
export const SCALE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

export function accentScale(accent: string): Record<(typeof SCALE_STEPS)[number], string> | null {
  const base = parseColour(accent);
  if (!base) return null;
  // 600 is the accent itself; lighter steps mix with white, darker ones with black.
  const toward: Record<number, [Rgb, number]> = {
    50: [WHITE, 0.92],
    100: [WHITE, 0.84],
    200: [WHITE, 0.7],
    300: [WHITE, 0.52],
    400: [WHITE, 0.3],
    500: [WHITE, 0.14],
    600: [WHITE, 0],
    700: [BLACK, 0.16],
    800: [BLACK, 0.32],
    900: [BLACK, 0.5],
    950: [BLACK, 0.68],
  };
  const out = {} as Record<(typeof SCALE_STEPS)[number], string>;
  for (const step of SCALE_STEPS) {
    const [target, amount] = toward[step] as [Rgb, number];
    out[step] = toHex(mix(base, target, amount));
  }
  return out;
}
