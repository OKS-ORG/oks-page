// The three looks of the admin and their colours (docs/18-new-look.md): Clear Sky (the default), Pine and Ember, each in
// light and dark. This table is the single source: `packages/admin/src/looks.css` is written from it (run
// `UPDATE_LOOKS=1 pnpm vitest run packages/core/src/looks.test.ts`), and that test fails when the file is out of date or a
// colour pair is not readable. No browser code here.
import { accentScale, SCALE_STEPS } from "./accent.js";

export const LOOK_KEYS = ["clear-sky", "pine", "ember"] as const;
export type LookKey = (typeof LOOK_KEYS)[number];
export const DEFAULT_LOOK: LookKey = "clear-sky";

export const isLook = (v: unknown): v is LookKey =>
  typeof v === "string" && (LOOK_KEYS as readonly string[]).includes(v);

export interface LookColours {
  ground: string;
  card: string;
  accent: string;
  /** Text on the accent. */
  on: string;
  /** The pale fill of a selected item, and the accent-coloured text on it. */
  sel: string;
  selText: string;
  text: string;
  muted: string;
  /** The edge of a field or button. */
  border: string;
  /** A hairline between rows and around cards. */
  line: string;
  /** A hovered row or menu item. */
  hover: string;
  /** The frosted sidebar and the soft shape behind it. */
  glass: string;
  glassEdge: string;
  blob: string;
  /** Messages: the same in every look, always shown with words and an icon. */
  okBg: string;
  okFg: string;
  warnBg: string;
  warnFg: string;
  errBg: string;
  errFg: string;
  infoBg: string;
  infoFg: string;
  shadow: string;
}

export interface Look {
  key: LookKey;
  name: string;
  /** Corner of a control (button, field, menu item); a card is this plus 4. */
  radius: number;
  /** Font families the look uses (library keys), headings then text. */
  fonts: { heading: string; text: string };
  /** CSS font-family values. */
  stacks: { heading: string; text: string };
  headingWeight: number;
  light: LookColours;
  dark: LookColours;
}

const MSG_LIGHT = {
  okBg: "#e6f4ea",
  okFg: "#146c2e",
  warnBg: "#fef7e0",
  warnFg: "#7a4f00",
  errBg: "#fce8e6",
  errFg: "#b3261e",
};
const MSG_DARK = {
  okBg: "#1e3a2a",
  okFg: "#8fd6a3",
  warnBg: "#3d3118",
  warnFg: "#f1c76b",
  errBg: "#3c1f1d",
  errFg: "#f2b8b5",
};
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif';

export const LOOKS: Record<LookKey, Look> = {
  "clear-sky": {
    key: "clear-sky",
    name: "Clear Sky",
    radius: 12,
    fonts: { heading: "figtree", text: "figtree" },
    stacks: { heading: `"Figtree", ${SANS}`, text: `"Figtree", ${SANS}` },
    headingWeight: 700,
    light: {
      ground: "#f6f8fc",
      card: "#ffffff",
      accent: "#0b57d0",
      on: "#ffffff",
      sel: "#d3e3fd",
      selText: "#0b57d0",
      text: "#1f1f1f",
      muted: "#444746",
      border: "#747775",
      line: "#e1e3e1",
      hover: "#eef3fd",
      glass: "rgba(255, 255, 255, 0.72)",
      glassEdge: "rgba(255, 255, 255, 0.9)",
      blob: "#d3e3fd",
      infoBg: "#e8f0fe",
      infoFg: "#0842a0",
      shadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
      ...MSG_LIGHT,
    },
    dark: {
      ground: "#131314",
      card: "#1e1f20",
      accent: "#a8c7fa",
      on: "#062e6f",
      sel: "#2b3a55",
      selText: "#a8c7fa",
      text: "#e3e3e3",
      muted: "#c4c7c5",
      border: "#8e918f",
      line: "#333536",
      hover: "#26282c",
      glass: "rgba(255, 255, 255, 0.07)",
      glassEdge: "rgba(255, 255, 255, 0.14)",
      blob: "#2b3a55",
      infoBg: "#2b3a55",
      infoFg: "#a8c7fa",
      shadow: "0 1px 2px rgba(0, 0, 0, 0.4)",
      ...MSG_DARK,
    },
  },
  pine: {
    key: "pine",
    name: "Pine",
    radius: 10,
    fonts: { heading: "source-serif-4", text: "manrope" },
    stacks: { heading: `"Source Serif 4", ${SERIF}`, text: `"Manrope", ${SANS}` },
    headingWeight: 700,
    light: {
      ground: "#f4f3ef",
      card: "#fffefb",
      accent: "#0f6b5c",
      on: "#ffffff",
      sel: "#d5e8e2",
      selText: "#0b4f44",
      text: "#1c1f1d",
      muted: "#4a4f4c",
      border: "#8a8f8b",
      line: "#e3e1d8",
      hover: "#edf3f0",
      glass: "rgba(255, 254, 251, 0.72)",
      glassEdge: "rgba(255, 255, 255, 0.9)",
      blob: "#d5e8e2",
      infoBg: "#d5e8e2",
      infoFg: "#0b4f44",
      shadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
      ...MSG_LIGHT,
    },
    dark: {
      ground: "#161917",
      card: "#202421",
      accent: "#7fcfbb",
      on: "#0b2e27",
      sel: "#26413a",
      selText: "#7fcfbb",
      text: "#e6e8e5",
      muted: "#b9beba",
      border: "#8a908c",
      line: "#333936",
      hover: "#272c29",
      glass: "rgba(255, 255, 255, 0.07)",
      glassEdge: "rgba(255, 255, 255, 0.14)",
      blob: "#26413a",
      infoBg: "#26413a",
      infoFg: "#7fcfbb",
      shadow: "0 1px 2px rgba(0, 0, 0, 0.4)",
      ...MSG_DARK,
    },
  },
  ember: {
    key: "ember",
    name: "Ember",
    radius: 8,
    fonts: { heading: "dm-sans", text: "dm-sans" },
    stacks: { heading: `"DM Sans", ${SANS}`, text: `"DM Sans", ${SANS}` },
    headingWeight: 700,
    light: {
      ground: "#faf7f6",
      card: "#ffffff",
      accent: "#c8372d",
      on: "#ffffff",
      sel: "#fde4e0",
      selText: "#8c1f17",
      text: "#1d1b1b",
      muted: "#5a5252",
      border: "#8c8282",
      line: "#e6dfdd",
      hover: "#fbf1ef",
      glass: "rgba(255, 255, 255, 0.72)",
      glassEdge: "rgba(255, 255, 255, 0.9)",
      blob: "#fde4e0",
      infoBg: "#fde4e0",
      infoFg: "#8c1f17",
      shadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
      ...MSG_LIGHT,
    },
    dark: {
      ground: "#14161a",
      card: "#1d2026",
      accent: "#ff6b57",
      on: "#14161a",
      sel: "#3a2522",
      selText: "#ff9a8b",
      text: "#ecedef",
      muted: "#b4b8bf",
      border: "#6b7079",
      line: "#2c3037",
      hover: "#23272e",
      glass: "rgba(255, 255, 255, 0.07)",
      glassEdge: "rgba(255, 255, 255, 0.14)",
      blob: "#3a2522",
      infoBg: "#3a2522",
      infoFg: "#ff9a8b",
      shadow: "0 1px 2px rgba(0, 0, 0, 0.4)",
      ...MSG_DARK,
    },
  },
};

/** The CSS variables of one look in one mode (what `.oks-admin` and the older oks-ui tokens read). */
export function lookVariables(look: Look, mode: "light" | "dark"): Record<string, string> {
  const c = look[mode];
  const scale = accentScale(c.accent)!;
  const v: Record<string, string> = {
    "--adm-ink": c.text,
    "--adm-ink-2": c.text,
    "--adm-muted": c.muted,
    "--adm-ground": c.ground,
    "--adm-panel": c.ground,
    "--adm-card": c.card,
    "--adm-line": c.line,
    "--adm-line-2": c.line,
    "--adm-control": c.border,
    "--adm-soft": c.sel,
    "--adm-on-soft": c.selText,
    "--adm-link": c.selText,
    "--adm-a1": c.accent,
    "--adm-a2": c.accent,
    "--adm-on-accent": c.on,
    "--adm-ring": `color-mix(in srgb, ${c.accent} 40%, transparent)`,
    "--adm-hover": c.hover,
    "--adm-row-hover": c.hover,
    "--adm-th": c.ground,
    "--adm-cap": c.muted,
    "--adm-shadow": c.shadow,
    "--adm-glass": c.glass,
    "--adm-glass-edge": c.glassEdge,
    "--adm-blob": c.blob,
    "--adm-ok-bg": c.okBg,
    "--adm-ok-fg": c.okFg,
    "--adm-warn-bg": c.warnBg,
    "--adm-warn-fg": c.warnFg,
    "--adm-err-bg": c.errBg,
    "--adm-err-fg": c.errFg,
    "--adm-info-bg": c.infoBg,
    "--adm-info-fg": c.infoFg,
    "--adm-radius": `${look.radius}px`,
    "--adm-radius-card": `${look.radius + 4}px`,
    "--adm-font-heading": look.stacks.heading,
    "--adm-font-text": look.stacks.text,
    "--adm-heading-weight": String(look.headingWeight),
  };
  for (const step of SCALE_STEPS) v[`--oks-color-primary-${step}`] = scale[step];
  v["--oks-color-surface"] = c.card;
  v["--oks-color-fg"] = c.text;
  v["--oks-color-fg-muted"] = c.muted;
  v["--oks-color-border"] = c.border;
  // oks-ui reads its radius tokens too.
  v["--oks-radius-xs"] = "4px";
  v["--oks-radius-sm"] = `${Math.max(4, look.radius - 4)}px`;
  v["--oks-radius-md"] = `${look.radius}px`;
  v["--oks-radius-lg"] = `${look.radius + 4}px`;
  return v;
}

/** A shell used on its own (tests, embeds) gets the default look; inside `.oks-admin` it inherits that wrapper's look and mode. */
const LONE_SHELL = ".oks-shell:not(.oks-admin .oks-shell)";

const block = (selector: string, vars: Record<string, string>, indent = ""): string =>
  `${indent}${selector} {\n${Object.entries(vars)
    .map(([k, val]) => `${indent}  ${k}: ${val};`)
    .join("\n")}\n${indent}}\n`;

/**
 * The whole of `looks.css`. Zero specificity on the light default (`:where`), so an agency's own colour or the person's
 * accent, set on the same element, always wins. Dark follows the device unless the page says `data-theme="light"`.
 */
export function looksCss(): string {
  const parts: string[] = [
    "/* Written from packages/core/src/looks.ts (UPDATE_LOOKS=1 vitest run packages/core/src/looks.test.ts). Do not edit by hand. */\n",
  ];
  for (const key of LOOK_KEYS) {
    const look = LOOKS[key];
    const sel =
      key === DEFAULT_LOOK ? `:where(.oks-admin, ${LONE_SHELL})` : `.oks-admin[data-look="${key}"]`;
    parts.push(`/* ${look.name}, light */\n` + block(sel, lookVariables(look, "light")));
  }
  for (const key of LOOK_KEYS) {
    const look = LOOKS[key];
    const dark = lookVariables(look, "dark");
    const attr =
      key === DEFAULT_LOOK
        ? `.oks-admin:not([data-look]), .oks-admin[data-look="${key}"], ${LONE_SHELL}`
        : `.oks-admin[data-look="${key}"]`;
    const root = (s: string) =>
      attr
        .split(", ")
        .map((a) => `${s} ${a}`)
        .join(",\n");
    parts.push(
      `/* ${look.name}, dark: follows the device unless the page asks for light */\n@media (prefers-color-scheme: dark) {\n${block(
        root(':root:not([data-theme="light"])'),
        dark,
        "  ",
      )}}\n` +
        `/* ${look.name}, dark: asked for by the page */\n${block(root(':root[data-theme="dark"]'), dark)}`,
    );
  }
  return parts.join("\n");
}
