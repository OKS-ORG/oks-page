// The owner's look settings (Design > Styles): one main color and two fonts, kept in the site's `settings` table under
// the key `theme`. The CSS is always written from the checked values by `theme.ts`, never stored or typed.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import { checkThemeCss, describeCssProblems } from "./css-check.js";
import {
  DEFAULT_THEME_STYLES,
  FONT_CHOICES,
  isLibraryFont,
  parseHex,
  stylesToCss,
  type ThemeStyles,
} from "./theme.js";

export const THEME_SETTINGS_KEY = "theme";

export type ThemeResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

/** A system font or a font of the built-in library. */
const isFont = (value: unknown): value is string =>
  typeof value === "string" && ((FONT_CHOICES as string[]).includes(value) || isLibraryFont(value));
const isMainColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) && parseHex(value) !== null;

/** Stored custom CSS is checked again when read; damaged or unsafe text means no custom CSS. */
function readCustomCss(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  const checked = checkThemeCss(raw);
  return checked.ok ? checked.css : "";
}

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
    logoMediaId:
      typeof saved["logoMediaId"] === "string" && saved["logoMediaId"].length <= 64
        ? saved["logoMediaId"]
        : null,
    bodyFont: isFont(saved["bodyFont"]) ? saved["bodyFont"] : DEFAULT_THEME_STYLES.bodyFont,
    customCss: readCustomCss(saved["customCss"]),
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
  input: Partial<{
    mainColor: string | null;
    logoMediaId: string | null;
    customCss: string;
    bodyFont: string;
    headingFont: string;
  }>,
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
  let logoMediaId = current.logoMediaId;
  if (input.logoMediaId !== undefined) {
    if (input.logoMediaId === null) logoMediaId = null;
    else {
      const rows =
        typeof input.logoMediaId === "string"
          ? await runner.all(
              `select "id" from "media" where "site_id" = ? and "id" = ? and "status" = 'ready'
                and "mime_type" like 'image/%' and "mime_type" <> 'image/svg+xml'`,
              [siteId, input.logoMediaId],
            )
          : [];
      if (!rows[0])
        return bad("logoMediaId", "Choose a picture from the media library for the logo.");
      logoMediaId = input.logoMediaId;
    }
  }
  let customCss = current.customCss;
  if (input.customCss !== undefined) {
    if (typeof input.customCss !== "string") return bad("customCss", "The CSS was not understood.");
    const checked = checkThemeCss(input.customCss);
    if (!checked.ok) return bad("customCss", describeCssProblems(checked.errors));
    customCss = checked.css;
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

  const styles: ThemeStyles = { mainColor, logoMediaId, customCss, bodyFont, headingFont };
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, THEME_SETTINGS_KEY, JSON.stringify(styles), new Date()],
  );
  return { ok: true, styles };
}
