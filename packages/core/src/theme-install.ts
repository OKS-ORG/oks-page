// Installing, using, rolling back and removing theme packages (spec 05, section 11). The facts live in the `themes` table:
// which theme, which version, which one is used, the report, and the small text parts (design values, CSS source and
// layouts). The fonts and pictures, and the one CSS file the public pages load, live in file storage under `themes/`,
// each named by the SHA-256 of its bytes, so a browser or a CDN may keep it forever and a file two versions share is
// stored once. The original package is kept under `theme-packages/` (never served) so a version can be checked again.
//
// One row per theme: `settings` holds the version in use (`current`) and the one before it (`previous`), so rolling
// back is one switch and rolling back again goes forward.
import { createHash } from "node:crypto";
import { newId, type SqlRunner } from "@oks-page/db";
import type { StorageAdapter } from "@oks-page/media";
import type { Actor } from "./content.js";
import { tokensToCss, type ThemeTokens } from "./theme.js";
import {
  checkThemePackage,
  type PackageReport,
  type ThemeFont,
  type ThemeLayout,
} from "./theme-package.js";

/** The biggest theme file that may be uploaded (the packed .tgz; the unpacked limit is checked while reading it). */
export const THEME_UPLOAD_MAX_BYTES = 24 * 1024 * 1024;

/** A file the site serves for a theme: `themes/<sha256>.<type>`. Anything else under `themes/` is never served. */
export const THEME_FILE_KEY = /^themes\/([0-9a-f]{64})\.(css|woff2|png|jpg|jpeg|webp|avif)$/;
const PACKAGE_KEY = /^theme-packages\/[0-9a-f]{64}\.tgz$/;

/** The content type of a served theme file, by its key. */
export function themeFileType(key: string): string | null {
  const match = THEME_FILE_KEY.exec(key);
  if (!match) return null;
  return (
    {
      css: "text/css; charset=utf-8",
      woff2: "font/woff2",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      avif: "image/avif",
    }[match[2]!] ?? null
  );
}

/** True when the bytes are the file the key names (its name is the SHA-256 of its bytes). */
export function themeFileMatches(key: string, bytes: Uint8Array): boolean {
  const match = THEME_FILE_KEY.exec(key);
  return !!match && sha256(bytes) === match[1];
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One installed version of a theme, as kept in `themes.settings`. */
export interface ThemeVersion {
  version: string;
  name: string;
  description: string;
  author: string;
  license: string;
  rtl: "supported" | "untested";
  options: string[];
  tokens: ThemeTokens;
  fonts: ThemeFont[];
  /** The checked CSS as the author wrote it (addresses still point inside the package). */
  css: string;
  /** The CSS file the public pages load, or null when the theme has nothing to say about the look. */
  cssKey: string | null;
  /** Every font and picture, by its path in the package, to its key in storage. */
  files: Record<string, string>;
  packageKey: string;
  templates: ThemeLayout[];
  parts: ThemeLayout[];
  patterns: ThemeLayout[];
  report: PackageReport;
  installedAt: number;
  installedBy: string;
}

interface StoredTheme {
  current: ThemeVersion;
  previous: ThemeVersion | null;
}

/** What the screens show about an installed theme. */
export interface InstalledTheme {
  id: string;
  key: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  rtl: "supported" | "untested";
  isActive: boolean;
  /** The version a roll back goes to, if there is one. */
  previousVersion: string | null;
  layouts: number;
  parts: number;
  sections: number;
  fonts: number;
  installedAt: number;
  report: PackageReport;
}

export type ThemeActionResult<T> =
  | ({ ok: true } & T)
  | {
      ok: false;
      code: "forbidden" | "invalid" | "not_found";
      message: string;
      report?: PackageReport;
    };

const forbidden = {
  ok: false,
  code: "forbidden",
  message: "You may not change the design.",
} as const;

/** A stored row's settings: PostgreSQL gives an object, SQLite gives text. Damaged data gives null. */
function readStored(raw: unknown): StoredTheme | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const stored = value as Partial<StoredTheme>;
  const good = (v: unknown): v is ThemeVersion =>
    !!v &&
    typeof v === "object" &&
    typeof (v as ThemeVersion).version === "string" &&
    ((v as ThemeVersion).cssKey === null ||
      THEME_FILE_KEY.test(String((v as ThemeVersion).cssKey)));
  if (!good(stored.current)) return null;
  return { current: stored.current, previous: good(stored.previous) ? stored.previous : null };
}

function summary(row: Record<string, unknown>, stored: StoredTheme): InstalledTheme {
  const c = stored.current;
  return {
    id: String(row["id"]),
    key: String(row["key"]),
    name: c.name,
    version: c.version,
    description: c.description,
    author: c.author,
    license: c.license,
    rtl: c.rtl,
    isActive: Boolean(row["is_active"]),
    previousVersion: stored.previous?.version ?? null,
    layouts: c.templates.length,
    parts: c.parts.length,
    sections: c.patterns.length,
    fonts: c.fonts.length,
    installedAt: c.installedAt,
    report: c.report,
  };
}

/** Every theme installed on the site, the one in use first. */
export async function listThemes(runner: SqlRunner, siteId: string): Promise<InstalledTheme[]> {
  const rows = await runner.all(
    `select "id", "key", "is_active", "settings" from "themes" where "site_id" = ? and "source" = 'runtime'`,
    [siteId],
  );
  const out: InstalledTheme[] = [];
  for (const row of rows) {
    const stored = readStored(row["settings"]);
    if (stored) out.push(summary(row, stored));
  }
  return out.sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name),
  );
}

/** The storage key of the CSS file of the theme in use, or null (no theme in use, or it changes nothing). */
export async function loadActiveThemeCssKey(
  runner: SqlRunner,
  siteId: string,
): Promise<string | null> {
  const rows = await runner.all(
    `select "settings" from "themes" where "site_id" = ? and "is_active" = ? and "source" = 'runtime'`,
    [siteId, true],
  );
  const stored = rows[0] ? readStored(rows[0]["settings"]) : null;
  return stored?.current.cssKey ?? null;
}

/** The CSS file of one version: the fonts, the design values, then the theme's own CSS with its addresses filled in. */
function buildCss(
  fonts: ThemeFont[],
  tokens: ThemeTokens,
  css: string,
  urlOf: (path: string) => string | null,
): string {
  const parts: string[] = [];
  for (const font of fonts) {
    const url = urlOf(font.file);
    if (url)
      parts.push(
        `@font-face{font-family:"${font.family}";src:url("${url}") format("woff2");font-weight:${font.weight};font-style:${font.style};font-display:swap}`,
      );
  }
  const values = tokensToCss(tokens);
  if (values) parts.push(values);
  // The checker allowed only plain addresses (letters, digits, "_ - . / space") inside url(), so they are found exactly.
  if (css)
    parts.push(
      css.replace(
        /url\(\s*(["']?)([^"'()]*?)\1\s*\)/g,
        (whole, _quote: string, address: string) => {
          const url = urlOf(address.trim());
          return url ? `url("${url}")` : whole;
        },
      ),
    );
  return parts.join("\n");
}

async function putOnce(storage: StorageAdapter, key: string, bytes: Uint8Array): Promise<void> {
  if (!(await storage.exists(key))) await storage.put(key, bytes);
}

/** Every storage key a version uses. */
const keysOf = (v: ThemeVersion): string[] => [
  ...Object.values(v.files),
  ...(v.cssKey ? [v.cssKey] : []),
  v.packageKey,
];

/** Deletes the given files when no theme (on any site sharing this storage) still uses them. */
async function deleteUnused(runner: SqlRunner, storage: StorageAdapter, keys: string[]) {
  if (keys.length === 0) return;
  const used = new Set<string>();
  for (const row of await runner.all(`select "settings" from "themes"`)) {
    const stored = readStored(row["settings"]);
    if (!stored) continue;
    for (const k of keysOf(stored.current)) used.add(k);
    if (stored.previous) for (const k of keysOf(stored.previous)) used.add(k);
  }
  for (const key of new Set(keys))
    if (!used.has(key) && (THEME_FILE_KEY.test(key) || PACKAGE_KEY.test(key)))
      await storage.delete(key).catch(() => undefined);
}

/**
 * Checks a theme package and, when nothing is refused, stores it. A new theme is stored as "not in use". A newer (or
 * other) version of an installed theme replaces it and the old one is kept for a roll back; when that theme is in use,
 * the site uses the new version at once. Nothing is stored when a check fails. Needs `themes.manage`.
 */
export async function installTheme(
  runner: SqlRunner,
  storage: StorageAdapter,
  actor: Actor,
  siteId: string,
  archive: Buffer,
  now: number = Date.now(),
): Promise<
  ThemeActionResult<{
    theme: InstalledTheme;
    report: PackageReport;
    change: "new" | "update" | "same";
  }>
> {
  if (!actor.can("themes.manage")) return forbidden;
  if (archive.length > THEME_UPLOAD_MAX_BYTES)
    return {
      ok: false,
      code: "invalid",
      message: "This file is too large for a theme (24 MB at most).",
      report: { passed: [], warnings: [], refused: ["The file is larger than 24 MB."] },
    };
  const checked = checkThemePackage(archive);
  if (!checked.ok)
    return {
      ok: false,
      code: "invalid",
      message: "This theme cannot be installed. The report says why.",
      report: checked.report,
    };
  const theme = checked.theme;
  const report = checked.report;
  const packageKey = `theme-packages/${sha256(archive)}.tgz`;

  const existing = (
    await runner.all(
      `select "id", "key", "source", "is_active", "settings" from "themes" where "site_id" = ? and "key" = ?`,
      [siteId, theme.key],
    )
  )[0];
  if (existing && existing["source"] === "build")
    return {
      ok: false,
      code: "invalid",
      message: `A theme built into the site already uses the name "${theme.key}".`,
      report,
    };
  const before = existing ? readStored(existing["settings"]) : null;
  if (existing && before && before.current.packageKey === packageKey)
    return { ok: true, theme: summary(existing, before), report, change: "same" };

  // The files first, so the database never names a file that is not there.
  const files: Record<string, string> = {};
  for (const [path, bytes] of theme.assets) {
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const key = `themes/${sha256(bytes)}.${extension}`;
    if (!THEME_FILE_KEY.test(key)) continue;
    await putOnce(storage, key, bytes);
    files[path] = key;
  }
  const css = buildCss(theme.fonts, theme.tokens, theme.css, (path) =>
    files[path] ? storage.publicUrl(files[path]) : null,
  );
  let cssKey: string | null = null;
  if (css) {
    const bytes = Buffer.from(css, "utf8");
    cssKey = `themes/${sha256(bytes)}.css`;
    await putOnce(storage, cssKey, bytes);
  }
  await putOnce(storage, packageKey, archive);

  const version: ThemeVersion = {
    version: theme.version,
    name: theme.name,
    description: theme.description,
    author: theme.author,
    license: theme.license,
    rtl: theme.rtl,
    options: theme.options,
    tokens: theme.tokens,
    fonts: theme.fonts,
    css: theme.css,
    cssKey,
    files,
    packageKey,
    templates: theme.templates,
    parts: theme.parts,
    patterns: theme.patterns,
    report,
    installedAt: now,
    installedBy: actor.userId,
  };

  if (existing) {
    const dropped = before?.previous ?? null;
    const stored: StoredTheme = { current: version, previous: before?.current ?? null };
    await runner.all(`update "themes" set "version" = ?, "settings" = ? where "id" = ?`, [
      version.version,
      JSON.stringify(stored),
      existing["id"],
    ]);
    if (dropped) await deleteUnused(runner, storage, keysOf(dropped));
    return { ok: true, theme: summary(existing, stored), report, change: "update" };
  }
  const id = newId();
  const stored: StoredTheme = { current: version, previous: null };
  await runner.all(
    `insert into "themes" ("id", "site_id", "key", "version", "source", "is_active", "settings")
      values (?, ?, ?, ?, 'runtime', ?, ?)`,
    [id, siteId, theme.key, version.version, false, JSON.stringify(stored)],
  );
  return {
    ok: true,
    theme: summary({ id, key: theme.key, is_active: false }, stored),
    report,
    change: "new",
  };
}

async function findTheme(runner: SqlRunner, siteId: string, id: string) {
  const row = (
    await runner.all(
      `select "id", "key", "is_active", "settings" from "themes"
        where "site_id" = ? and "id" = ? and "source" = 'runtime'`,
      [siteId, id],
    )
  )[0];
  const stored = row ? readStored(row["settings"]) : null;
  return row && stored ? { row, stored } : null;
}

const notFound = { ok: false, code: "not_found", message: "That theme is not installed." } as const;

/** Uses a theme on the site, or (with `null`) goes back to the built-in design. Content is never changed. */
export async function useTheme(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string | null,
): Promise<ThemeActionResult<{ active: InstalledTheme | null }>> {
  if (!actor.can("themes.manage")) return forbidden;
  if (id === null) {
    await runner.all(`update "themes" set "is_active" = ? where "site_id" = ?`, [false, siteId]);
    return { ok: true, active: null };
  }
  const found = await findTheme(runner, siteId, id);
  if (!found) return notFound;
  await runner.transaction(async (tx) => {
    await tx.all(`update "themes" set "is_active" = ? where "site_id" = ? and "id" <> ?`, [
      false,
      siteId,
      id,
    ]);
    await tx.all(`update "themes" set "is_active" = ? where "id" = ?`, [true, id]);
  });
  return { ok: true, active: summary({ ...found.row, is_active: true }, found.stored) };
}

/** Goes back to the version installed before this one. Rolling back again returns to the newer version. */
export async function rollBackTheme(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<ThemeActionResult<{ theme: InstalledTheme }>> {
  if (!actor.can("themes.manage")) return forbidden;
  const found = await findTheme(runner, siteId, id);
  if (!found) return notFound;
  const { previous, current } = found.stored;
  if (!previous)
    return {
      ok: false,
      code: "invalid",
      message: "This theme has no earlier version to go back to.",
    };
  const stored: StoredTheme = { current: previous, previous: current };
  await runner.all(`update "themes" set "version" = ?, "settings" = ? where "id" = ?`, [
    previous.version,
    JSON.stringify(stored),
    id,
  ]);
  return { ok: true, theme: summary(found.row, stored) };
}

/** Removes a theme that is not in use, with its files (unless another theme shares them). */
export async function removeTheme(
  runner: SqlRunner,
  storage: StorageAdapter,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<ThemeActionResult<object>> {
  if (!actor.can("themes.manage")) return forbidden;
  const found = await findTheme(runner, siteId, id);
  if (!found) return notFound;
  if (found.row["is_active"])
    return {
      ok: false,
      code: "invalid",
      message: "This theme is in use. Use another design first, then remove it.",
    };
  await runner.all(`delete from "themes" where "id" = ?`, [id]);
  const { current, previous } = found.stored;
  await deleteUnused(runner, storage, [...keysOf(current), ...(previous ? keysOf(previous) : [])]);
  return { ok: true };
}
