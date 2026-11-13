// The owner's changes to a theme's layouts (spec 05, sections 10 and 17.5). The theme's own layouts are never changed:
// a change is kept in `theme_overrides`, one row per layout ("templates/index", "parts/header"), as a draft until it is
// published. Publishing saves every changed layout at once and keeps the last 20 published versions of each in
// `theme_override_versions`. Each change remembers the fingerprint of the theme layout it started from, so a theme update
// that changes that layout marks it "owner-outdated"; the owner then keeps theirs, uses the new one, or compares them.
import { createHash } from "node:crypto";
import { checkBlocks, type Block } from "@oks-page/content-safety";
import { newId, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import { loadThemeVersion, type ThemeActionResult, type ThemeVersion } from "./theme-install.js";
import { checkParts, type ThemeLayout } from "./theme-package.js";

/** How many published versions of each layout are kept. */
export const LAYOUT_HISTORY = 20;

/** "theme": the theme's own; "owner": the owner's change on the theme's current layout; "owner-outdated": the theme
 * changed the layout since the owner changed it. */
export type LayoutState = "theme" | "owner" | "owner-outdated";

export interface LayoutInfo {
  /** "templates/<name>" or "parts/<name>". */
  key: string;
  kind: "template" | "part";
  name: string;
  /** The title the theme gives it (or its name). */
  title: string;
  state: LayoutState;
  /** True when there are changes not published yet. */
  hasDraft: boolean;
  /** False when a theme update removed the layout the owner had changed. */
  inTheme: boolean;
}

export interface LayoutDetail extends LayoutInfo {
  /** The theme's own blocks (null when the theme no longer has this layout). */
  theme: Block[] | null;
  /** The owner's published blocks, or null. */
  published: Block[] | null;
  /** The owner's unpublished blocks, or null. */
  draft: Block[] | null;
  /** The theme version the owner's change started from ("" when there is none). */
  baseVersion: string;
  /** The theme version installed now. */
  themeVersion: string;
}

export interface LayoutVersion {
  id: string;
  publishedAt: number;
  /** The name of the person who published it ("" when unknown or deleted). */
  publishedBy: string;
}

const KEY = /^(templates|parts)\/([a-z0-9][a-z0-9-]{0,63})$/;
const forbidden = {
  ok: false,
  code: "forbidden",
  message: "You may not change the site design.",
} as const;
const notFound = { ok: false, code: "not_found", message: "That layout does not exist." } as const;
const invalid = (message: string) => ({ ok: false, code: "invalid", message }) as const;

/** JSON with the keys of every object in order, so the same blocks always give the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The fingerprint of a layout's blocks; the order of keys inside a block does not change it (TH-38). */
export function layoutHash(blocks: unknown): string {
  return createHash("sha256").update(canonical(blocks)).digest("hex");
}

const readJson = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
/** Stored blocks are checked again whenever they are read. */
const blocksOf = (raw: unknown): Block[] | null => {
  const value = readJson(raw);
  if (value === null || value === undefined) return null;
  return checkBlocks(value).body.blocks;
};

function themeLayoutOf(version: ThemeVersion, key: string): ThemeLayout | null {
  const match = KEY.exec(key);
  if (!match) return null;
  const list = match[1] === "templates" ? version.templates : version.parts;
  return list.find((l) => l.name === match[2]) ?? null;
}

interface OverrideRow {
  key: string;
  published: Block[] | null;
  draft: Block[] | null;
  baseHash: string;
  baseVersion: string;
}

async function overridesOf(runner: SqlRunner, themeId: string): Promise<Map<string, OverrideRow>> {
  const rows = await runner.all(
    `select "template_key", "content", "draft", "base_hash", "base_version" from "theme_overrides"
      where "theme_id" = ? and "kind" = 'theme'`,
    [themeId],
  );
  const out = new Map<string, OverrideRow>();
  for (const row of rows) {
    const key = String(row["template_key"]);
    if (!KEY.test(key)) continue;
    out.set(key, {
      key,
      published: blocksOf(row["content"]),
      draft: blocksOf(row["draft"]),
      baseHash: String(row["base_hash"]),
      baseVersion: String(row["base_version"]),
    });
  }
  return out;
}

function info(key: string, theme: ThemeLayout | null, row: OverrideRow | undefined): LayoutInfo {
  const [, folder, name] = KEY.exec(key)!;
  let state: LayoutState = "theme";
  if (row?.published)
    state = theme && row.baseHash === layoutHash(theme.blocks) ? "owner" : "owner-outdated";
  if (row?.published && !theme) state = "owner";
  return {
    key,
    kind: folder === "templates" ? "template" : "part",
    name: name!,
    title: theme?.title ?? name!,
    state,
    hasDraft: !!row?.draft,
    inTheme: !!theme,
  };
}

async function themeFor(runner: SqlRunner, actor: Actor, siteId: string, themeId: string) {
  if (!actor.can("themes.manage")) return forbidden;
  const found = await loadThemeVersion(runner, siteId, themeId);
  if (!found)
    return { ok: false, code: "not_found", message: "That theme is not installed." } as const;
  return { ok: true, version: found.version } as const;
}

/** Every layout of a theme with its state: the theme's own, and any the owner changed that a theme update removed. */
export async function listLayouts(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
): Promise<ThemeActionResult<{ layouts: LayoutInfo[] }>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  const rows = await overridesOf(runner, themeId);
  const keys = [
    ...theme.version.templates.map((t) => `templates/${t.name}`),
    ...theme.version.parts.map((p) => `parts/${p.name}`),
  ];
  for (const key of rows.keys()) if (!keys.includes(key)) keys.push(key);
  return {
    ok: true,
    layouts: keys.map((key) => info(key, themeLayoutOf(theme.version, key), rows.get(key))),
  };
}

/** One layout: the theme's blocks, the owner's published and draft blocks, and its state. */
export async function getLayout(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
  key: string,
): Promise<ThemeActionResult<{ layout: LayoutDetail }>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  const themeLayout = themeLayoutOf(theme.version, key);
  const row = (await overridesOf(runner, themeId)).get(key);
  if (!themeLayout && !row) return notFound;
  return {
    ok: true,
    layout: {
      ...info(key, themeLayout, row),
      theme: themeLayout?.blocks ?? null,
      published: row?.published ?? null,
      draft: row?.draft ?? null,
      baseVersion: row?.baseVersion ?? "",
      themeVersion: theme.version.version,
    },
  };
}

/**
 * The checks a set of layouts must pass together: every part a layout names exists, no part includes itself, nesting
 * and size stay within the limits. `changed` replaces the theme's blocks for the given keys.
 */
function checkTogether(version: ThemeVersion, changed: Map<string, Block[]>): string[] {
  const problems: string[] = [];
  const use = (folder: "templates" | "parts", list: ThemeLayout[]) => {
    const out = list.map((l) => ({ ...l, blocks: changed.get(`${folder}/${l.name}`) ?? l.blocks }));
    for (const [key, blocks] of changed) {
      const match = KEY.exec(key)!;
      if (match[1] === folder && !list.some((l) => l.name === match[2]))
        out.push({ name: match[2]!, title: match[2]!, blocks });
    }
    return out;
  };
  checkParts(use("templates", version.templates), use("parts", version.parts), (m) =>
    problems.push(m),
  );
  return problems;
}

/** Keeps changes to a layout as a draft (not shown to visitors). The blocks are checked like page content. */
export async function saveLayoutDraft(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
  key: string,
  blocks: unknown,
  now: number = Date.now(),
): Promise<ThemeActionResult<{ layout: LayoutInfo; repairs: number }>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  if (!KEY.test(key)) return notFound;
  const themeLayout = themeLayoutOf(theme.version, key);
  const rows = await overridesOf(runner, themeId);
  const row = rows.get(key);
  if (!themeLayout && !row) return notFound;
  if (!Array.isArray(blocks)) return invalid("A layout must be a list of blocks.");
  const checked = checkBlocks({ version: 1, blocks });
  // Every other layout as it would be published now: the drafts first, then the published changes.
  const changed = new Map<string, Block[]>();
  for (const r of rows.values()) {
    const effective = r.draft ?? r.published;
    if (effective) changed.set(r.key, effective);
  }
  changed.set(key, checked.body.blocks);
  const problems = checkTogether(theme.version, changed);
  if (problems.length > 0) return invalid(problems.join(" "));

  const value = JSON.stringify(checked.body.blocks);
  if (row)
    await runner.all(
      `update "theme_overrides" set "draft" = ?, "updated_at" = ? where "theme_id" = ? and "template_key" = ?`,
      [value, new Date(now), themeId, key],
    );
  else
    await runner.all(
      `insert into "theme_overrides" ("theme_id", "template_key", "content", "draft", "kind", "name", "base_hash",
        "base_version", "updated_at") values (?, ?, null, ?, 'theme', '', ?, ?, ?)`,
      [
        themeId,
        key,
        value,
        themeLayout ? layoutHash(themeLayout.blocks) : "",
        theme.version.version,
        new Date(now),
      ],
    );
  return {
    ok: true,
    layout: info(key, themeLayout, {
      key,
      published: row?.published ?? null,
      draft: checked.body.blocks,
      baseHash: row?.baseHash ?? (themeLayout ? layoutHash(themeLayout.blocks) : ""),
      baseVersion: row?.baseVersion ?? theme.version.version,
    }),
    repairs: checked.repairs.length,
  };
}

/** Throws away the draft of one layout; what is published stays. */
export async function discardLayoutDraft(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
  key: string,
): Promise<ThemeActionResult<object>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  await runner.all(
    `update "theme_overrides" set "draft" = null where "theme_id" = ? and "template_key" = ?`,
    [themeId, key],
  );
  await runner.all(
    `delete from "theme_overrides" where "theme_id" = ? and "template_key" = ? and "content" is null`,
    [themeId, key],
  );
  return { ok: true };
}

/**
 * Publishes every layout that has a draft, all at once (spec 05, 17.5): checked together first, so either all are
 * published or none. Each one gets a version in the history, which keeps the newest 20 of each layout.
 */
export async function publishLayouts(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
  now: number = Date.now(),
): Promise<ThemeActionResult<{ published: string[] }>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  const rows = await overridesOf(runner, themeId);
  const drafts = [...rows.values()].filter((r) => r.draft);
  if (drafts.length === 0) return { ok: true, published: [] };
  const changed = new Map<string, Block[]>();
  for (const r of rows.values()) {
    const effective = r.draft ?? r.published;
    if (effective) changed.set(r.key, effective);
  }
  const problems = checkTogether(theme.version, changed);
  if (problems.length > 0) return invalid(problems.join(" "));

  await runner.transaction(async (tx) => {
    for (const r of drafts) {
      const themeLayout = themeLayoutOf(theme.version, r.key);
      const value = JSON.stringify(r.draft);
      // The first publish starts from the theme layout of now; later ones keep the base until "keep mine".
      const fresh = !r.published;
      await tx.all(
        `update "theme_overrides" set "content" = ?, "draft" = null, "updated_at" = ?
          ${fresh ? `, "base_hash" = ?, "base_version" = ?` : ""}
          where "theme_id" = ? and "template_key" = ?`,
        fresh
          ? [
              value,
              new Date(now),
              themeLayout ? layoutHash(themeLayout.blocks) : "",
              theme.version.version,
              themeId,
              r.key,
            ]
          : [value, new Date(now), themeId, r.key],
      );
      await tx.all(
        `insert into "theme_override_versions" ("id", "theme_id", "template_key", "content", "published_at", "published_by")
          values (?, ?, ?, ?, ?, ?)`,
        [newId(), themeId, r.key, value, new Date(now), actor.userId],
      );
      const old = await tx.all(
        `select "id" from "theme_override_versions" where "theme_id" = ? and "template_key" = ?
          order by "published_at" desc, "id" desc`,
        [themeId, r.key],
      );
      for (const extra of old.slice(LAYOUT_HISTORY))
        await tx.all(`delete from "theme_override_versions" where "id" = ?`, [extra["id"]]);
    }
  });
  return { ok: true, published: drafts.map((r) => r.key) };
}

/** The published versions of a layout, newest first (at most 20). */
export async function listLayoutVersions(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
  key: string,
): Promise<ThemeActionResult<{ versions: LayoutVersion[] }>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  const rows = await runner.all(
    `select v."id", v."published_at", u."name" from "theme_override_versions" v
      left join "users" u on u."id" = v."published_by"
      where v."theme_id" = ? and v."template_key" = ? order by v."published_at" desc, v."id" desc`,
    [themeId, key],
  );
  return {
    ok: true,
    versions: rows.map((r) => ({
      id: String(r["id"]),
      publishedAt: new Date(r["published_at"] as string | number | Date).getTime(),
      publishedBy: r["name"] == null ? "" : String(r["name"]),
    })),
  };
}

/** Makes a new draft from a published version (nothing changes for visitors until it is published). */
export async function restoreLayoutVersion(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
  versionId: string,
  now: number = Date.now(),
): Promise<ThemeActionResult<{ layout: LayoutInfo; repairs: number }>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  const row = (
    await runner.all(
      `select "template_key", "content" from "theme_override_versions" where "id" = ? and "theme_id" = ?`,
      [versionId, themeId],
    )
  )[0];
  if (!row) return { ok: false, code: "not_found", message: "That version does not exist." };
  return saveLayoutDraft(
    runner,
    actor,
    siteId,
    themeId,
    String(row["template_key"]),
    blocksOf(row["content"]) ?? [],
    now,
  );
}

/** "Keep mine": the owner's change stays and now counts as made on the theme's current layout. */
export async function keepMyLayout(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
  key: string,
): Promise<ThemeActionResult<{ layout: LayoutInfo }>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  const themeLayout = themeLayoutOf(theme.version, key);
  const row = (await overridesOf(runner, themeId)).get(key);
  if (!themeLayout || !row?.published) return notFound;
  const hash = layoutHash(themeLayout.blocks);
  await runner.all(
    `update "theme_overrides" set "base_hash" = ?, "base_version" = ? where "theme_id" = ? and "template_key" = ?`,
    [hash, theme.version.version, themeId, key],
  );
  return {
    ok: true,
    layout: info(key, themeLayout, { ...row, baseHash: hash, baseVersion: theme.version.version }),
  };
}

/**
 * "Use the theme's" (also "Reset to theme", and "Use the new one" after an update): the owner's change and draft are
 * removed and the theme's layout is used again. The history stays, so an old version can still be restored.
 */
export async function resetLayout(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
  key: string,
): Promise<ThemeActionResult<object>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  if (!themeLayoutOf(theme.version, key)) return notFound;
  await runner.all(`delete from "theme_overrides" where "theme_id" = ? and "template_key" = ?`, [
    themeId,
    key,
  ]);
  return { ok: true };
}
