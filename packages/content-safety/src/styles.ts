// Responsive styles of a block (spec 06, section 4): `props.style = { base: {…}, tablet: {…}, … }`, mobile first.
// Only allowed properties and values are kept; everything else is removed with a plain sentence. The CSS is generated
// here too, one class per distinct style (`oks-s-<10 hex>`), so a page needs no inline style (PB-13 to PB-17, PB-65).
import { isSafeColor } from "./schemes.js";

// ---- breakpoints (4.1) ----

export const BREAKPOINTS = [
  { name: "base", min: 0 },
  { name: "mobile-lg", min: 768 },
  { name: "tablet", min: 881 },
  { name: "tablet-lg", min: 1025 },
  { name: "laptop", min: 1201 },
  { name: "desktop", min: 1367 },
  { name: "widescreen", min: 2400 },
] as const;
export type BreakpointName = (typeof BREAKPOINTS)[number]["name"];
export const DEFAULT_BREAKPOINTS: BreakpointName[] = ["base", "tablet", "desktop"];

export interface BreakpointRange {
  name: BreakpointName;
  /** First width (in pixels) where this range applies. */
  from: number;
  /** Last width where it applies, or null for "and up". */
  to: number | null;
}

/** The ranges of the breakpoints that are on. `base` is always on. An enabled breakpoint starts right after the
 * normal end of the previous enabled one, so there is never a gap or an overlap. */
export function breakpointRanges(
  enabled: readonly string[] = DEFAULT_BREAKPOINTS,
): BreakpointRange[] {
  const on = BREAKPOINTS.map((b, i) => ({ ...b, i })).filter(
    (b) => b.name === "base" || enabled.includes(b.name),
  );
  return on.map((b, k) => {
    const prev = on[k - 1];
    const from = prev ? BREAKPOINTS[prev.i + 1]!.min : 0;
    const next = on[k + 1];
    const to = next ? BREAKPOINTS[b.i + 1]!.min - 1 : null;
    return { name: b.name, from, to };
  });
}

// ---- allowed values (4.2, 4.4) ----

type Check = (value: string) => string | null;

const LENGTH = /^-?\d{1,4}(\.\d{1,3})?(px|rem|em|%|vh|vw|ch)$/;
const POSITIVE_LENGTH = /^\d{1,4}(\.\d{1,3})?(px|rem|em|%|vh|vw|ch)$/;
const SPACE_TOKEN = /^space\.(\d{1,2})$/;

/** A length, `0`, or a space token (`space.4`, written as `var(--oks-space-4)`). */
const length =
  (opts: { auto?: boolean; negative?: boolean } = {}): Check =>
  (v) => {
    if (v === "0") return "0";
    if (opts.auto && v === "auto") return "auto";
    const token = SPACE_TOKEN.exec(v);
    if (token) return `var(--oks-space-${token[1]})`;
    return (opts.negative ? LENGTH : POSITIVE_LENGTH).test(v) ? v : null;
  };

const oneOf =
  (...words: string[]): Check =>
  (v) =>
    words.includes(v) ? v : null;

const colour: Check = (v) => (isSafeColor(v) ? v.trim() : null);
const number =
  (min: number, max: number): Check =>
  (v) => {
    const n = Number(v);
    return /^\d{1,4}(\.\d{1,3})?$/.test(v) && n >= min && n <= max ? v : null;
  };

const gridColumns: Check = (v) => {
  const repeat = /^repeat\((\d{1,2}), ?minmax\(0, ?1fr\)\)$/.exec(v);
  if (repeat) {
    const n = Number(repeat[1]);
    return n >= 1 && n <= 12 ? `repeat(${n},minmax(0,1fr))` : null;
  }
  const tracks = v.split(" ");
  if (tracks.length < 1 || tracks.length > 12) return null;
  return tracks.every((t) => /^\d{1,3}(\.\d{1,2})?fr$/.test(t) || POSITIVE_LENGTH.test(t))
    ? v
    : null;
};

const fontFamily: Check = (v) =>
  v === "heading"
    ? "var(--oks-site-font-heading)"
    : v === "body"
      ? "var(--oks-site-font-body)"
      : null;

const BORDER_RADIUS_LOGICAL = [
  "border-start-start-radius",
  "border-start-end-radius",
  "border-end-start-radius",
  "border-end-end-radius",
];

const shadow: Check = (v) =>
  v.length <= 200 &&
  /^(none|[-\d.a-z#(),% ]+)$/i.test(v) &&
  !/url|var|expression|javascript|;/i.test(v)
    ? v
    : null;

/** Two to five colours and an angle: `linear-gradient(135deg, #fff, #000)`. */
const gradient: Check = (v) => {
  const m = /^linear-gradient\((\d{1,3})deg, ?(.+)\)$/.exec(v);
  if (!m || Number(m[1]) > 360) return null;
  // Colours may hold commas (rgb(...)): split only on commas outside brackets.
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of m[2]!) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  parts.push(current.trim());
  if (parts.length < 2 || parts.length > 5 || !parts.every((c) => isSafeColor(c))) return null;
  return `linear-gradient(${m[1]}deg,${parts.join(",")})`;
};

const SPACING = length({ auto: true, negative: true });
const PADDING = length();
const SIZE = length({ auto: true });
const ALLOWED: Record<string, Check> = {
  // spacing: horizontal ones are start/end (D77)
  margin: SPACING,
  "margin-block-start": SPACING,
  "margin-block-end": SPACING,
  "margin-inline-start": SPACING,
  "margin-inline-end": SPACING,
  padding: PADDING,
  "padding-block-start": PADDING,
  "padding-block-end": PADDING,
  "padding-inline-start": PADDING,
  "padding-inline-end": PADDING,
  // size
  width: SIZE,
  height: SIZE,
  "min-width": SIZE,
  "max-width": SIZE,
  "min-height": SIZE,
  "max-height": SIZE,
  // colours and borders
  color: colour,
  "background-color": colour,
  "background-image": gradient,
  "border-color": colour,
  "border-width": length(),
  "border-style": oneOf("none", "solid", "dashed", "dotted"),
  "border-radius": length(),
  ...Object.fromEntries(BORDER_RADIUS_LOGICAL.map((p) => [p, length()])),
  "box-shadow": shadow,
  // layout
  display: oneOf("block", "flex", "grid", "inline-block", "none"),
  "flex-direction": oneOf("row", "row-reverse", "column", "column-reverse"),
  "flex-wrap": oneOf("nowrap", "wrap", "wrap-reverse"),
  "flex-grow": number(0, 100),
  "flex-shrink": number(0, 100),
  "flex-basis": length({ auto: true }),
  "justify-content": oneOf(
    "start",
    "end",
    "center",
    "space-between",
    "space-around",
    "space-evenly",
  ),
  "align-items": oneOf("start", "end", "center", "stretch", "baseline"),
  "align-content": oneOf("start", "end", "center", "stretch", "space-between", "space-around"),
  "align-self": oneOf("auto", "start", "end", "center", "stretch", "baseline"),
  gap: length(),
  "row-gap": length(),
  "column-gap": length(),
  "grid-template-columns": gridColumns,
  // text
  "text-align": oneOf("start", "end", "center", "justify"),
  "font-size": length(),
  "font-weight": (v) => (/^[1-9]00$/.test(v) || v === "normal" || v === "bold" ? v : null),
  "font-family": fontFamily,
  // free positioning (7)
  position: oneOf("relative", "absolute"),
  top: length({ auto: true, negative: true }),
  bottom: length({ auto: true, negative: true }),
  "inset-inline-start": length({ auto: true, negative: true }),
  "inset-inline-end": length({ auto: true, negative: true }),
};

/** The properties a block style may set (for the editor's list). */
export const STYLE_PROPERTIES: string[] = Object.keys(ALLOWED).sort();

/** Physical horizontal properties are no longer accepted; an old page's are converted (D77, PB-71). */
const PHYSICAL: Record<string, string> = {
  "margin-left": "margin-inline-start",
  "margin-right": "margin-inline-end",
  "padding-left": "padding-inline-start",
  "padding-right": "padding-inline-end",
  left: "inset-inline-start",
  right: "inset-inline-end",
};

export type Style = Partial<Record<BreakpointName, Record<string, string>>>;

export interface CheckedStyle {
  style: Style;
  /** One plain sentence for everything that was removed. */
  messages: string[];
}

const KNOWN = new Set<string>(BREAKPOINTS.map((b) => b.name));

/** Keeps only what is allowed, for the breakpoints that are on. */
export function checkStyle(
  raw: unknown,
  enabled: readonly string[] = DEFAULT_BREAKPOINTS,
): CheckedStyle {
  const messages: string[] = [];
  const style: Style = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined)
      messages.push("The style of this block could not be read, so it was cleared.");
    return { style, messages };
  }
  const on = new Set(["base", ...enabled]);
  for (const [name, declarations] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN.has(name) || !on.has(name)) {
      messages.push(
        KNOWN.has(name)
          ? `The ${name} screen size is switched off, so its styles were removed.`
          : `"${name}" is not a screen size, so its styles were removed.`,
      );
      continue;
    }
    if (declarations === null || typeof declarations !== "object" || Array.isArray(declarations))
      continue;
    const kept: Record<string, string> = {};
    for (const [property, value] of Object.entries(declarations as Record<string, unknown>)) {
      const check = ALLOWED[property];
      if (typeof value !== "string" || value.length > 200) {
        messages.push(`The value of ${property} was too long or not text, so it was removed.`);
      } else if (property in PHYSICAL) {
        messages.push(
          `${property} was removed: use ${PHYSICAL[property]} so right-to-left sites mirror correctly.`,
        );
      } else if (!check) {
        messages.push(`${property} is not allowed in a block style, so it was removed.`);
      } else {
        const good = check(value.trim());
        if (good === null)
          messages.push(
            `"${value.slice(0, 40)}" is not allowed for ${property}, so it was removed.`,
          );
        else kept[property] = good;
      }
    }
    if (Object.keys(kept).length > 0) style[name as BreakpointName] = kept;
  }
  return { style, messages };
}

/** An older page's physical horizontal properties become start and end (PB-71). */
export function convertPhysicalStyle(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [name, declarations] of Object.entries(raw as Record<string, unknown>)) {
    if (declarations === null || typeof declarations !== "object" || Array.isArray(declarations)) {
      out[name] = declarations;
      continue;
    }
    const converted: Record<string, unknown> = {};
    for (const [property, value] of Object.entries(declarations as Record<string, unknown>)) {
      if (property === "text-align" && (value === "left" || value === "right"))
        converted[property] = value === "left" ? "start" : "end";
      else converted[PHYSICAL[property] ?? property] = value;
    }
    out[name] = converted;
  }
  return out;
}

// ---- generated CSS (4.3) ----

/** A stable text for a style: the same whatever the key order, and never the same for two different styles. */
export function styleKey(style: Style): string {
  const parts: string[] = [];
  for (const { name } of BREAKPOINTS) {
    const declarations = style[name];
    if (!declarations) continue;
    const props = Object.keys(declarations)
      .sort()
      .map((p) => `${p}:${declarations[p]}`);
    if (props.length > 0) parts.push(`${name}{${props.join(";")}}`);
  }
  return parts.join("|");
}

/** A 53-bit hash of text (the same in the browser and on the server), as hex. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The class name of a style, or null when the style has nothing in it. */
export function styleClass(style: Style): string | null {
  const key = styleKey(style);
  return key === "" ? null : `oks-s-${hash(key).slice(-10)}`;
}

/** The CSS of a list of styles: one rule set per distinct style, base rules without a media query, larger screen
 * sizes in `@media (min-width: …)` in ascending order, never `max-width`. */
export function generateCss(
  styles: Style[],
  enabled: readonly string[] = DEFAULT_BREAKPOINTS,
): string {
  const ranges = breakpointRanges(enabled);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const style of styles) {
    const cls = styleClass(style);
    if (!cls || seen.has(cls)) continue;
    seen.add(cls);
    for (const range of ranges) {
      const declarations = style[range.name];
      if (!declarations) continue;
      const body = Object.keys(declarations)
        .sort()
        .map((p) => `${p}:${declarations[p]}`)
        .join(";");
      out.push(
        range.from === 0
          ? `.${cls}{${body}}`
          : `@media (min-width:${range.from}px){.${cls}{${body}}}`,
      );
    }
  }
  // Base rules first (they carry no media query), then the larger sizes from small to large.
  const order = (rule: string): number =>
    rule.startsWith("@media") ? Number(/min-width:(\d+)px/.exec(rule)![1]) : 0;
  return out
    .map((rule, i) => ({ rule, i }))
    .sort((a, b) => order(a.rule) - order(b.rule) || a.i - b.i)
    .map((r) => r.rule)
    .join("\n");
}
