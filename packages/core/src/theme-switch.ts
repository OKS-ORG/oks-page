// What a theme switch does, told before it happens (spec 05, section 17.7; TH-74). Nothing here changes data: it reads
// the site and says what is kept, what moves, what stays with the old theme, and which pages will use another layout.
// Switching itself is `useTheme`; this is the list the owner reads first.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import { pagesChoosing, type LayoutPage } from "./owner-layouts.js";
import { overridesOf } from "./theme-edits.js";
import { loadThemeVersion, type ThemeActionResult } from "./theme-install.js";
import { loadThemeStyles } from "./theme-settings.js";

/** The theme on one side of a switch; `null` is the built-in design. */
export interface SwitchSide {
  id: string | null;
  name: string;
  version: string | null;
}

export interface ThemeSwitchPlan {
  from: SwitchSide;
  to: SwitchSide;
  /** True when the target is the theme already in use: nothing would change. */
  same: boolean;
  /** Always kept: the site's own content and look. */
  kept: {
    pages: number;
    media: number;
    savedSections: number;
    mainColor: boolean;
    logo: boolean;
    customCss: boolean;
  };
  /** Stay with the old theme and come back if the owner switches back. */
  stays: {
    /** Titles of the layouts of the old theme the owner changed (published or draft). */
    changedLayouts: string[];
    /** Names of the layouts the owner made for the old theme. */
    ownerLayouts: string[];
  };
  /** Pages that chose a layout the new theme will not have; they use its Page layout instead. */
  pagesMoved: { total: number; pages: LayoutPage[] };
  /** What the new theme already has from an earlier time (the owner's changes come back). */
  comesBack: { changedLayouts: number; ownerLayouts: number };
}

const LIST_MAX = 20;
const BUILT_IN: SwitchSide = { id: null, name: "the built-in design", version: null };

/** The title of a layout key such as "templates/single-post". */
function titleOf(key: string): string {
  const name = key.slice(key.indexOf("/") + 1);
  return name
    .replace(/^custom-/, "")
    .split("-")
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase());
}

async function count(runner: SqlRunner, sql: string, args: unknown[]): Promise<number> {
  const rows = await runner.all(sql, args);
  return Number(rows[0]?.["n"] ?? 0);
}

async function sideOf(
  runner: SqlRunner,
  siteId: string,
  id: string | null,
): Promise<SwitchSide | null> {
  if (id === null) return BUILT_IN;
  const found = await loadThemeVersion(runner, siteId, id);
  return found ? { id, name: found.version.name, version: found.version.version } : null;
}

/** The theme in use now, or the built-in design. */
async function activeId(runner: SqlRunner, siteId: string): Promise<string | null> {
  const rows = await runner.all(
    `select "id" from "themes" where "site_id" = ? and "is_active" = ? and "source" = 'runtime'`,
    [siteId, true],
  );
  return rows[0] ? String(rows[0]["id"]) : null;
}

/** Layouts of a theme the owner has: changes to a theme layout, and layouts the owner made. */
async function ownersWork(runner: SqlRunner, themeId: string | null) {
  const changed: string[] = [];
  const made: { key: string; name: string }[] = [];
  if (!themeId) return { changed, made };
  for (const [key, row] of await overridesOf(runner, themeId)) {
    if (!key.startsWith("templates/") && !key.startsWith("parts/")) continue;
    if (row.kind === "owner-made") made.push({ key, name: row.name || titleOf(key) });
    else if (row.published || row.draft) changed.push(titleOf(key));
  }
  return { changed: changed.sort(), made: made.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Says what switching to `targetId` (`null` is the built-in design) would keep, move and leave behind. */
export async function planThemeSwitch(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  targetId: string | null,
): Promise<ThemeActionResult<{ plan: ThemeSwitchPlan }>> {
  if (!actor.can("themes.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the design." };
  const to = await sideOf(runner, siteId, targetId);
  if (!to) return { ok: false, code: "not_found", message: "That theme is not installed." };
  const fromId = await activeId(runner, siteId);
  const from = (await sideOf(runner, siteId, fromId)) ?? BUILT_IN;
  const same = from.id === to.id;

  const styles = await loadThemeStyles(runner, siteId);
  const old = await ownersWork(runner, same ? null : fromId);
  const next = await ownersWork(runner, same ? null : targetId);

  // A page keeps its layout when the new theme has one of the same name (its own, or one the owner made there).
  const nextNames = new Set(next.made.map((m) => m.key.slice("templates/".length)));
  const moved: LayoutPage[] = [];
  const seen = new Set<string>();
  for (const layout of old.made) {
    if (!layout.key.startsWith("templates/custom-")) continue;
    const name = layout.key.slice("templates/".length);
    if (nextNames.has(name)) continue;
    for (const page of await pagesChoosing(runner, siteId, name)) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      moved.push(page);
    }
  }

  return {
    ok: true,
    plan: {
      from,
      to,
      same,
      kept: {
        pages: await count(
          runner,
          `select count(*) as "n" from "entries" where "site_id" = ? and "status" <> 'trash'`,
          [siteId],
        ),
        media: await count(
          runner,
          `select count(*) as "n" from "media" where "site_id" = ? and "status" = 'ready'`,
          [siteId],
        ),
        savedSections: await count(
          runner,
          `select count(*) as "n" from "saved_sections" where "site_id" = ?`,
          [siteId],
        ),
        mainColor: styles.mainColor !== null,
        logo: styles.logoMediaId !== null,
        customCss: styles.customCss.length > 0,
      },
      stays: { changedLayouts: old.changed, ownerLayouts: old.made.map((m) => m.name) },
      pagesMoved: { total: moved.length, pages: moved.slice(0, LIST_MAX) },
      comesBack: { changedLayouts: next.changed.length, ownerLayouts: next.made.length },
    },
  };
}
