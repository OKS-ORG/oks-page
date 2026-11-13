// The owner's look settings (Design > Styles): one main color and two fonts, kept in the site's `settings` table under
// the key `theme`. The CSS is always written from the checked values by `theme.ts`, never stored or typed.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import {
  DEFAULT_THEME_STYLES,
  FONT_CHOICES,
  parseHex,
  stylesToCss,
  type FontChoice,
  type ThemeStyles,
} from "./theme.js";

export const THEME_SETTINGS_KEY = "theme";

export type ThemeResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

const isFont = (value: unknown): value is FontChoice =>
  typeof value === "string" && (FONT_CHOICES as string[]).includes(value);
const isMainColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) && parseHex(value) !== null;

/** What a stored value means. Anything damaged or unknown falls back to the built-in look, field by field. */
export function readThemeStyles(raw: unknown): ThemeStyles {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  const saved = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    mainColor: isMainColor(saved["mainColor"]) ? saved["mainColor"].toLowerCase() : null,
    bodyFont: isFont(saved["bodyFont"]) ? saved["bodyFont"] : DEFAULT_THEME_STYLES.bodyFont,
    headingFont: isFont(saved["headingFont"])
      ? saved["headingFont"]
      : DEFAULT_THEME_STYLES.headingFont,
  };
}

export async function loadThemeStyles(runner: SqlRunner, siteId: string): Promise<ThemeStyles> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, THEME_SETTINGS_KEY],
  );
  return readThemeStyles(rows[0]?.["value"]);
}

/** The CSS the public pages carry; empty while the site still has the built-in look. */
export async function loadThemeCss(runner: SqlRunner, siteId: string): Promise<string> {
  return stylesToCss(await loadThemeStyles(runner, siteId));
}

/** Saves the look; only the parts that are given change. Needs `settings.manage`. */
export async function saveThemeStyles(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: Partial<{ mainColor: string | null; bodyFont: string; headingFont: string }>,
): Promise<ThemeResult<{ styles: ThemeStyles }>> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the design." };
  const current = await loadThemeStyles(runner, siteId);
  const bad = (field: string, message: string) =>
    ({ ok: false, code: "invalid", field, message }) as const;

  let mainColor = current.mainColor;
  if (input.mainColor !== undefined) {
    if (input.mainColor === null) mainColor = null;
    else if (!isMainColor(input.mainColor))
      return bad("mainColor", "Choose a color as six letters or digits, like #2a6f4f.");
    else mainColor = input.mainColor.toLowerCase();
  }
  let bodyFont = current.bodyFont;
  if (input.bodyFont !== undefined) {
    if (!isFont(input.bodyFont)) return bad("bodyFont", "Choose a font from the list.");
    bodyFont = input.bodyFont;
  }
  let headingFont = current.headingFont;
  if (input.headingFont !== undefined) {
    if (!isFont(input.headingFont)) return bad("headingFont", "Choose a font from the list.");
    headingFont = input.headingFont;
  }

  const styles: ThemeStyles = { mainColor, bodyFont, headingFont };
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, THEME_SETTINGS_KEY, JSON.stringify(styles), new Date()],
  );
  return { ok: true, styles };
}
