// "Export as a theme" (spec 05, sections 17.6 and 17.10; TH-73): a theme package made from a theme as this site shows it
// now, to install on another site. It starts from the original package the theme was installed from (so its fonts,
// pictures, README and licence come along), and puts in:
//   - every layout as published here: the owner's changes in place of the theme's own, and the layouts the owner made;
//   - the saved sections as ready-made sections ("patterns"), and every linked section put in place as its blocks,
//     since a theme cannot link to another site's sections;
//   - the owner's look (main color, fonts) on top of the theme's design values, and the owner's own CSS after the theme's.
// Drafts are left out. The result passes the same package checks as any theme before it is handed over.
import { checkBlocks, type Block } from "@oks-page/content-safety";
import type { SqlRunner } from "@oks-page/db";
import type { StorageAdapter } from "@oks-page/media";
import type { Actor } from "./content.js";
import { expandLinked, loadSectionBlocks } from "./saved-sections.js";
import { readTarGz, writeTarGz } from "./tar.js";
import { overridesOf } from "./theme-edits.js";
import { loadThemeVersion, type ThemeActionResult } from "./theme-install.js";
import {
  checkThemePackage,
  PACKAGE_MAX_UNPACKED_BYTES,
  type PackageReport,
} from "./theme-package.js";
import { loadThemeStyles } from "./theme-settings.js";
import { stylesToTokens, type ThemeTokens } from "./theme.js";

export const EXPORT_NAME_MAX = 60;

const slugOf = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "") || "theme";

/** The theme's design values with the owner's look on top (the owner's value wins for each name). */
function mergeTokens(theme: ThemeTokens, owner: ThemeTokens): ThemeTokens {
  const out: ThemeTokens = {};
  const color = { ...(theme.color ?? {}), ...(owner.color ?? {}) };
  const radius = { ...(theme.radius ?? {}), ...(owner.radius ?? {}) };
  const font = { ...(theme.font ?? {}), ...(owner.font ?? {}) };
  const dark = { ...(theme.dark?.color ?? {}), ...(owner.dark?.color ?? {}) };
  if (Object.keys(color).length > 0) out.color = color;
  if (Object.keys(radius).length > 0) out.radius = radius;
  if (Object.keys(font).length > 0) out.font = font;
  if (Object.keys(dark).length > 0) out.dark = { color: dark };
  return out;
}

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/**
 * Makes the package. `name` is the new theme's name (by default "<theme> (custom)"); its key comes from the name, so
 * installing it on this site makes a new theme and never replaces the one it came from.
 */
export async function exportTheme(
  runner: SqlRunner,
  storage: StorageAdapter,
  actor: Actor,
  siteId: string,
  themeId: string,
  input: { name?: unknown } = {},
): Promise<ThemeActionResult<{ archive: Buffer; fileName: string; report: PackageReport }>> {
  if (!actor.can("themes.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site design." };
  const found = await loadThemeVersion(runner, siteId, themeId);
  if (!found) return { ok: false, code: "not_found", message: "That theme is not installed." };
  const version = found.version;
  const keyRows = await runner.all(`select "key" from "themes" where "id" = ?`, [themeId]);
  const fromKey = String(keyRows[0]?.["key"] ?? "theme");

  const name =
    typeof input.name === "string" && input.name.trim()
      ? input.name.replace(/\s+/g, " ").trim()
      : `${version.name} (custom)`;
  if (name.length > EXPORT_NAME_MAX)
    return {
      ok: false,
      code: "invalid",
      message: `Give the theme a name of 1 to ${EXPORT_NAME_MAX} characters.`,
    };
  let key = slugOf(name);
  if (key === fromKey) key = `${key}-custom`;

  // The original package, as it was installed.
  let original: Buffer;
  try {
    original = Buffer.from(await storage.get(version.packageKey));
  } catch {
    return {
      ok: false,
      code: "invalid",
      message: "The original theme file is missing from the storage, so it cannot be exported.",
    };
  }
  const read = readTarGz(original, PACKAGE_MAX_UNPACKED_BYTES + 2 * 1024 * 1024);
  if (!read.ok) return { ok: false, code: "invalid", message: read.error };
  let entries = read.entries.filter((e) => e.kind === "file");
  if (entries.length > 0 && entries.every((e) => e.path.startsWith("package/")))
    entries = entries.map((e) => ({ ...e, path: e.path.slice("package/".length) }));
  const rewritten = (path: string) =>
    path === "theme.json" ||
    path === "styles/theme.css" ||
    /^(templates|parts|patterns)\//.test(path);
  const files = new Map<string, Buffer>();
  for (const e of entries) if (!rewritten(e.path)) files.set(e.path, e.data);

  // theme.json: the new name and key, the design values with the owner's look.
  const manifestEntry = entries.find((e) => e.path === "theme.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestEntry?.data.toString("utf8") ?? "{}") as Record<string, unknown>;
  } catch {
    manifest = {}; // the package passed the checks when it was installed, so this does not happen
  }
  const styles = await loadThemeStyles(runner, siteId);
  const tokens = mergeTokens(version.tokens, stylesToTokens(styles));
  files.set(
    "theme.json",
    json({
      ...manifest,
      key,
      name,
      version: "1.0.0",
      description:
        `${version.name} ${version.version} with this site's changes. ${version.description}`.trim(),
      tokens,
    }),
  );

  // The CSS: the theme's own as written, then the owner's.
  const css = [
    entries.find((e) => e.path === "styles/theme.css")?.data.toString("utf8") ?? "",
    styles.customCss ? `/* This site's own CSS */\n${styles.customCss}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (css) files.set("styles/theme.css", Buffer.from(`${css}\n`));

  // The layouts as published here, with linked sections put in place.
  const sections = await loadSectionBlocks(runner, siteId);
  const ready = (blocks: unknown): Block[] =>
    expandLinked(checkBlocks({ version: 1, blocks }).body.blocks, sections);
  const rows = await overridesOf(runner, themeId);
  const write = (
    folder: "templates" | "parts",
    list: { name: string; title: string; blocks: Block[] }[],
  ) => {
    for (const layout of list) {
      const row = rows.get(`${folder}/${layout.name}`);
      files.set(
        `${folder}/${layout.name}.json`,
        json({ title: layout.title, blocks: ready(row?.published ?? layout.blocks) }),
      );
    }
  };
  write("templates", version.templates);
  write("parts", version.parts);
  for (const row of rows.values()) {
    const [folder, layoutName] = row.key.split("/") as [string, string];
    if (row.kind !== "owner-made" || !row.published || files.has(`${folder}/${layoutName}.json`))
      continue;
    files.set(
      `${folder}/${layoutName}.json`,
      json({ title: row.name || layoutName, blocks: ready(row.published) }),
    );
  }

  // Ready-made sections: the theme's, then the saved sections of this site.
  for (const pattern of version.patterns)
    files.set(
      `patterns/${pattern.name}.json`,
      json({
        title: pattern.title,
        group: pattern.group ?? "other",
        blocks: ready(pattern.blocks),
      }),
    );
  const saved = await runner.all(
    `select "id", "name", "section_group" from "saved_sections" where "site_id" = ? order by "name"`,
    [siteId],
  );
  for (const s of saved) {
    const base = `saved-${slugOf(String(s["name"]))}`;
    let file = base;
    for (let n = 2; files.has(`patterns/${file}.json`); n++) file = `${base}-${n}`;
    files.set(
      `patterns/${file}.json`,
      json({
        title: String(s["name"]),
        group: String(s["section_group"]),
        blocks: ready(sections.get(String(s["id"])) ?? []),
      }),
    );
  }

  const archive = writeTarGz(
    [...files.entries()]
      .sort(([a], [b]) => (a === "theme.json" ? -1 : b === "theme.json" ? 1 : a.localeCompare(b)))
      .map(([path, data]) => ({ path, data })),
  );
  const check = checkThemePackage(archive);
  if (!check.ok)
    return {
      ok: false,
      code: "invalid",
      message: `The exported theme would not pass the theme checks: ${check.report.refused.join(" ")}`,
    };
  return { ok: true, archive, fileName: `${key}-1.0.0.tgz`, report: check.report };
}
