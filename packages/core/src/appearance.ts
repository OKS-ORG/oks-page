// How the admin looks for one person (docs/18-new-look.md, step 7): the look, light or dark, an accent colour, and whether the
// side menu is the icon rail. Kept per person on the site, in the settings table under `appearance:<user id>`, so it follows the
// person to every browser. A person who has chosen nothing gets the site's default (an agency may set one), then the product's.
// No browser-only code here: the Appearance screen uses `appearanceCss` to show a choice at once, before it is saved.
import type { SqlRunner } from "@oks-page/db";
import { deriveAccent } from "./accent.js";
import {
  DEFAULT_LOOK,
  isLook,
  LOOKS,
  lookVariables,
  type LookColours,
  type LookKey,
} from "./looks.js";

export const APPEARANCE_MODES = ["light", "dark", "system"] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];
export const isAppearanceMode = (v: unknown): v is AppearanceMode =>
  typeof v === "string" && (APPEARANCE_MODES as readonly string[]).includes(v);

export interface Appearance {
  look: LookKey;
  mode: AppearanceMode;
  /** "#rrggbb", or "" for the look's own accent. */
  accent: string;
  /** The side menu as the icon rail (true), the full menu (false), or null while the person has not chosen. */
  menuCollapsed: boolean | null;
}

export const DEFAULT_APPEARANCE: Appearance = {
  look: DEFAULT_LOOK,
  mode: "system",
  accent: "",
  menuCollapsed: null,
};

const COLOUR = /^#[0-9a-f]{6}$/;
const keyOf = (userId: string) => `appearance:${userId}`;

/** What a person chose, made safe: a field that is missing or unreadable is simply not there. */
function readPartial(raw: unknown): Partial<Appearance> {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      v = null;
    }
  }
  const o =
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: Partial<Appearance> = {};
  if (isLook(o["look"])) out.look = o["look"];
  if (isAppearanceMode(o["mode"])) out.mode = o["mode"];
  const accent = typeof o["accent"] === "string" ? o["accent"].toLowerCase() : "";
  if (COLOUR.test(accent)) out.accent = accent;
  if (typeof o["menuCollapsed"] === "boolean") out.menuCollapsed = o["menuCollapsed"];
  return out;
}

/** What is stored on top of the default (the site's, or the product's): the person's own choices win field by field. */
export function readAppearance(raw: unknown, base: Appearance = DEFAULT_APPEARANCE): Appearance {
  return { ...base, ...readPartial(raw) };
}

/** The colours of one look in one mode with the person's accent worked in (too pale or too dark a colour is nudged until it reads). */
export function coloursFor(
  look: LookKey,
  mode: "light" | "dark",
  accent: string,
): { colours: LookColours; adjusted: boolean } {
  const base = LOOKS[look][mode];
  if (!accent) return { colours: base, adjusted: false };
  const derived = deriveAccent(accent, {
    card: base.card,
    ground: base.ground,
    dark: mode === "dark",
  });
  if (!derived) return { colours: base, adjusted: false };
  return {
    colours: {
      ...base,
      accent: derived.accent,
      on: derived.on,
      sel: derived.sel,
      selText: derived.selText,
      hover: derived.hover,
      blob: derived.sel,
      infoBg: derived.sel,
      infoFg: derived.selText,
    },
    adjusted: derived.adjusted,
  };
}

/** True when the accent had to be changed to stay readable in either mode (the screen then says so). */
export function accentAdjusted(look: LookKey, accent: string): boolean {
  return (
    accent !== "" &&
    (coloursFor(look, "light", accent).adjusted || coloursFor(look, "dark", accent).adjusted)
  );
}

const rules = (selector: string, vars: Record<string, string>): string =>
  `${selector}{${Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}}`;

/**
 * The style rules that give `.oks-admin[data-appearance]` this person's look: written after the look's own file and heavier than
 * it, so a person who chose light on a dark device gets light. Nothing is needed for the default choice (the look's file has it).
 */
export function appearanceCss(a: Appearance): string {
  const look = LOOKS[a.look];
  const vars = (mode: "light" | "dark") =>
    lookVariables({ ...look, [mode]: coloursFor(a.look, mode, a.accent).colours }, mode);
  const at = ":root:root .oks-admin[data-look][data-appearance]";
  if (a.mode === "light") return rules(at, vars("light"));
  if (a.mode === "dark") return rules(at, vars("dark"));
  return `${rules(at, vars("light"))}\n@media (prefers-color-scheme: dark){${rules(at, vars("dark"))}}`;
}

/** Whether a stored choice differs from what the look's own file gives, so the page needs the extra rules. */
export const needsAppearanceCss = (a: Appearance): boolean =>
  a.mode !== "system" || a.accent !== "" || a.look !== DEFAULT_LOOK;

export interface Fail {
  ok: false;
  code: "invalid" | "forbidden";
  message: string;
  field?: string;
}

export async function loadAppearance(
  runner: SqlRunner,
  siteId: string,
  userId: string,
  base: Appearance = DEFAULT_APPEARANCE,
): Promise<Appearance> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, keyOf(userId)],
  );
  return rows[0] ? readAppearance(rows[0]["value"], base) : base;
}

/**
 * Saves what a person changed, keeping the rest. Only the fields given change; a field that is not understood is refused in
 * plain words. `accent: ""` goes back to the look's own colour.
 */
export async function saveAppearance(
  runner: SqlRunner,
  siteId: string,
  userId: string,
  input: unknown,
  base: Appearance = DEFAULT_APPEARANCE,
): Promise<{ ok: true; appearance: Appearance } | Fail> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { ok: false, code: "invalid", message: "The request was not understood." };
  const given = input as Record<string, unknown>;
  const unknown = Object.keys(given).find(
    (k) => !["look", "mode", "accent", "menuCollapsed"].includes(k),
  );
  if (unknown)
    return {
      ok: false,
      code: "invalid",
      message: "This is not an appearance setting.",
      field: unknown,
    };
  const bad = (field: string, message: string): Fail => ({
    ok: false,
    code: "invalid",
    message,
    field,
  });
  // Only what the person chose is kept, so a later change of the site default still reaches whatever they never chose.
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, keyOf(userId)],
  );
  const next: Partial<Appearance> = rows[0] ? readPartial(rows[0]["value"]) : {};
  if ("look" in given) {
    if (!isLook(given["look"])) return bad("look", "Choose Clear Sky, Pine or Ember.");
    next.look = given["look"];
  }
  if ("mode" in given) {
    if (!isAppearanceMode(given["mode"]))
      return bad("mode", "Choose light, dark, or the one that matches your device.");
    next.mode = given["mode"];
  }
  if ("accent" in given) {
    const raw = typeof given["accent"] === "string" ? given["accent"].trim().toLowerCase() : null;
    if (raw === null || (raw !== "" && !COLOUR.test(raw)))
      return bad("accent", "Write the colour like #1a5fb4 (a # and six letters or digits).");
    if (raw === "") delete next.accent;
    else next.accent = raw;
  }
  if ("menuCollapsed" in given) {
    if (typeof given["menuCollapsed"] !== "boolean")
      return bad("menuCollapsed", "The menu is either open or collapsed.");
    next.menuCollapsed = given["menuCollapsed"];
  }
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, keyOf(userId), JSON.stringify(next), new Date()],
  );
  return { ok: true, appearance: { ...base, ...next } };
}

/** Takes the person's own choices away, so the site's default (or the product's) shows again. */
export async function resetAppearance(
  runner: SqlRunner,
  siteId: string,
  userId: string,
): Promise<void> {
  await runner.all(`delete from "settings" where "site_id" = ? and "key" = ?`, [
    siteId,
    keyOf(userId),
  ]);
}
