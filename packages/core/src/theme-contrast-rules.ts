// The rules of the contrast check of a look (no database, so a screen can use them as the owner picks colors)
// The contrast check of a look (spec 05, sections 5 and 9; TH-52). It reads the colors the theme in use and the owner's
// main color give, works out what the page really shows in light and in dark, and says in plain words where text would
// be hard to read. It only warns; it never refuses (D68). Colors written as "#rgb" or "#rrggbb" are checked; any other
// form (such as rgb(...)) is left out, because the check does not guess.
import {
  contrastRatio,
  parseHex,
  stylesToTokens,
  type ThemeStyles,
  type ThemeTokens,
} from "./theme.js";

/** The ratio WCAG asks for normal text. */
export const NEEDED_CONTRAST = 4.5;

export interface ContrastWarning {
  mode: "light" | "dark";
  /** Which text: "text", "muted", "link" or "button". */
  part: "text" | "muted" | "link" | "button";
  /** The ratio found, rounded down to one decimal. */
  ratio: number;
  /** A sentence for the owner. */
  message: string;
}

// What the page looks like when nothing is set: oks-ui's own page colors.
const PAGE = { light: "#ffffff", dark: "#0a0a0a" } as const;
// The text on a solid main-color button: white in light mode, black in dark mode (the dark scale makes step 700 light).
const BUTTON_TEXT = { light: "#ffffff", dark: "#000000" } as const;
const PART_NAMES = {
  text: "the text",
  muted: "the quiet (muted) text",
  link: "the links",
  button: "the text on the main-color button",
} as const;

const checkable = (value: string | undefined): value is string =>
  value !== undefined && parseHex(value) !== null;

/** The colors one mode shows: the light values, and in dark the dark values written over them. */
function colorsOf(tokens: ThemeTokens, mode: "light" | "dark"): Record<string, string> {
  return { ...tokens.color, ...(mode === "dark" ? tokens.dark?.color : {}) };
}

/** The tokens the theme gives with the owner's main color written over them (the owner wins, as on the page). */
function merged(theme: ThemeTokens | null, owner: ThemeTokens): ThemeTokens {
  return {
    color: { ...theme?.color, ...owner.color },
    dark: { color: { ...theme?.dark?.color, ...owner.dark?.color } },
  };
}

/** The warnings for the modes the visitor can reach. Floors the ratio so "4.5" is never shown for 4.46. */
export function contrastWarnings(
  theme: ThemeTokens | null,
  styles: Pick<ThemeStyles, "mainColor" | "colorMode">,
): ContrastWarning[] {
  const tokens = merged(theme, stylesToTokens({ ...EMPTY, ...styles }));
  const modes: ("light" | "dark")[] =
    styles.colorMode === "light"
      ? ["light"]
      : styles.colorMode === "dark"
        ? ["dark"]
        : ["light", "dark"];
  const warnings: ContrastWarning[] = [];
  for (const mode of modes) {
    const colors = colorsOf(tokens, mode);
    const background = [colors["background"], colors["surface"]].find(checkable) ?? PAGE[mode];
    const pairs: [ContrastWarning["part"], string | undefined, string][] = [
      ["text", colors["text"], background],
      ["muted", colors["fg-muted"], background],
      ["link", colors["link"] ?? colors["primary-700"], background],
      ["button", BUTTON_TEXT[mode], colors["primary-700"] ?? ""],
    ];
    for (const [part, foreground, behind] of pairs) {
      if (!checkable(foreground) || !checkable(behind)) continue;
      const ratio = Math.floor(contrastRatio(foreground, behind) * 10) / 10;
      if (ratio >= NEEDED_CONTRAST) continue;
      warnings.push({
        mode,
        part,
        ratio,
        message: `In ${mode} mode ${PART_NAMES[part]} is hard to read (contrast ${ratio.toFixed(1)} to 1; it needs ${NEEDED_CONTRAST} to 1).`,
      });
    }
  }
  return warnings;
}

// Only used to fill the parts of `ThemeStyles` the check does not read.
const EMPTY: ThemeStyles = {
  mainColor: null,
  logoMediaId: null,
  customCss: "",
  bodyFont: "system-sans",
  headingFont: "system-sans",
  colorMode: "light",
  modeSwitch: false,
};
