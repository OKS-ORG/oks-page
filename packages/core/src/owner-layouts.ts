// Layouts the owner makes (spec 05, section 17.6; TH-72). Two kinds:
//   - a named layout that pages can choose in their settings ("Landing page", stored as `templates/custom-landing-page`);
//   - the layout of a content type the theme has none for ("Recipe", stored as `templates/single-recipe`, or
//     `templates/page` for pages), which the type's entries then use on their own.
// They live in `theme_overrides` with the kind "owner-made" and no base, so a theme update never touches them; they
// stay with their theme when the site switches theme, and come back when it switches back. A new layout starts as a
// copy of another one (draft first, then published) or from a blank page, and is published at once; later changes are
// drafts like any layout. Deleting one first lists the pages that chose it, which go back to their usual layout.
import { checkBlocks, type Block } from "@oks-page/content-safety";
import { newId, type SqlRunner } from "@oks-page/db";
import { loadForEdit, type Actor } from "./content.js";
import { missingLinks, savedSectionIds } from "./saved-sections.js";
import {
  checkTogether,
  overridesOf,
  themeFor,
  themeLayoutOf,
  type LayoutInfo,
} from "./theme-edits.js";
import { loadThemeVersion, type ThemeActionResult } from "./theme-install.js";
import { chosenLayout } from "./theme-layouts.js";

export const LAYOUT_NAME_MAX = 60;
const PREFIX = "custom-";
const TYPE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const invalid = (message: string) => ({ ok: false, code: "invalid", message }) as const;
const notFound = { ok: false, code: "not_found", message: "That layout does not exist." } as const;

/** The blocks a blank layout starts with: the page's title and its content. */
const blank = (): Block[] => [
  { id: "title", type: "post-title", props: {}, content: null, children: [] },
  { id: "content", type: "post-content", props: {}, content: null, children: [] },
];

/** "Landing page!" → "landing-page" (at most 50 characters, never empty). */
function slugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug || "layout";
}

/** The page layout a content type uses when it has its own: "page" for pages, "single-<type>" for the others. */
export const typeLayoutName = (type: string): string =>
  type === "page" ? "page" : `single-${type}`;

/** A page in the list of a layout's users. */
export interface LayoutPage {
  id: string;
  title: string;
  slug: string;
  type: string;
}

/** The entries (any status but the trash) that chose a layout in their settings. */
export async function pagesChoosing(
  runner: SqlRunner,
  siteId: string,
  name: string,
): Promise<LayoutPage[]> {
  const rows = await runner.all(
    `select "id", "title", "slug", "type_key", "meta" from "entries"
      where "site_id" = ? and "status" <> 'trash' order by "title"`,
    [siteId],
  );
  return rows
    .filter((r) => chosenLayout(r["meta"]) === name)
    .map((r) => ({
      id: String(r["id"]),
      title: String(r["title"]),
      slug: String(r["slug"]),
      type: String(r["type_key"]),
    }));
}

/**
 * Makes a new layout: `for` "pages" (a named layout pages can choose) or a content type's key. It starts as a copy of
 * `from` (the key of any layout of the theme: what the owner sees there now, draft included) or "blank".
 */
export async function createOwnerLayout(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
  input: { name?: unknown; for?: unknown; from?: unknown },
  now: number = Date.now(),
): Promise<ThemeActionResult<{ layout: LayoutInfo }>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  const rows = await overridesOf(runner, themeId);
  const exists = (name: string) =>
    rows.has(`templates/${name}`) || theme.version.templates.some((t) => t.name === name);

  let name: string;
  let title: string;
  if (input.for === "pages") {
    title = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
    if (!title || title.length > LAYOUT_NAME_MAX)
      return invalid(`Give the layout a name of 1 to ${LAYOUT_NAME_MAX} characters.`);
    const titles = [
      ...[...rows.values()].map((r) => (r.kind === "owner-made" ? (r.name ?? "") : "")),
      ...theme.version.templates.map((t) => t.title),
    ];
    if (titles.some((t) => t.toLowerCase() === title.toLowerCase()))
      return invalid(`There is already a layout called "${title}".`);
    const base = `${PREFIX}${slugOf(title)}`;
    name = base;
    for (let n = 2; exists(name); n++) name = `${base}-${n}`;
  } else {
    const type = typeof input.for === "string" ? input.for : "";
    const known = await runner.all(
      `select "label" from "content_types" where "site_id" = ? and "key" = ?`,
      [siteId, type],
    );
    if (!TYPE.test(type) || !known[0]) return invalid("Choose a content type of this site.");
    name = typeLayoutName(type);
    if (exists(name))
      return invalid(
        `${String(known[0]["label"])} already has a layout of its own. Change that one instead.`,
      );
    title = String(known[0]["label"]);
  }

  let blocks: Block[];
  if (input.from === undefined || input.from === "blank") blocks = blank();
  else {
    const fromKey = String(input.from);
    const row = rows.get(fromKey);
    const themeLayout = themeLayoutOf(theme.version, fromKey);
    const start = row?.draft ?? row?.published ?? themeLayout?.blocks ?? null;
    if (!fromKey.startsWith("templates/") || !start)
      return invalid("Choose a page layout to start from, or a blank page.");
    blocks = start;
  }
  const checked = checkBlocks({ version: 1, blocks }).body.blocks;
  const key = `templates/${name}`;
  const changed = new Map<string, Block[]>();
  for (const r of rows.values()) {
    const effective = r.draft ?? r.published;
    if (effective) changed.set(r.key, effective);
  }
  changed.set(key, checked);
  const problems = [
    ...checkTogether(theme.version, changed),
    ...missingLinks(key, checked, await savedSectionIds(runner, siteId)),
  ];
  if (problems.length > 0) return invalid(problems.join(" "));

  const value = JSON.stringify(checked);
  await runner.transaction(async (tx) => {
    await tx.all(
      `insert into "theme_overrides" ("theme_id", "template_key", "content", "draft", "kind", "name", "base_hash",
        "base_version", "updated_at") values (?, ?, ?, null, 'owner-made', ?, '', '', ?)`,
      [themeId, key, value, title, new Date(now)],
    );
    await tx.all(
      `insert into "theme_override_versions" ("id", "theme_id", "template_key", "content", "published_at", "published_by")
        values (?, ?, ?, ?, ?, ?)`,
      [newId(), themeId, key, value, new Date(now), actor.userId],
    );
  });
  return {
    ok: true,
    layout: {
      key,
      kind: "template",
      name,
      title,
      state: "owner-made",
      hasDraft: false,
      inTheme: false,
    },
  };
}

/**
 * Deletes a layout the owner made (theme layouts cannot be deleted, only reset). The pages that chose it go back to
 * their usual layout first, all in one transaction, written to the audit log. Returns those pages.
 */
export async function deleteOwnerLayout(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  themeId: string,
  key: string,
  now: number = Date.now(),
): Promise<ThemeActionResult<{ moved: LayoutPage[] }>> {
  const theme = await themeFor(runner, actor, siteId, themeId);
  if (!theme.ok) return theme;
  const row = (await overridesOf(runner, themeId)).get(key);
  if (!row && !themeLayoutOf(theme.version, key)) return notFound;
  if (!row || row.kind !== "owner-made")
    return invalid("Only layouts you made can be deleted. A theme layout can be reset instead.");
  const name = key.slice("templates/".length);
  const moved = key.startsWith("templates/") ? await pagesChoosing(runner, siteId, name) : [];
  await runner.transaction(async (tx) => {
    for (const page of moved) {
      const stored = await tx.all(`select "meta" from "entries" where "id" = ?`, [page.id]);
      let meta: Record<string, unknown> = {};
      const raw = stored[0]?.["meta"];
      try {
        const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (value && typeof value === "object") meta = { ...(value as Record<string, unknown>) };
      } catch {
        // a damaged value is replaced by an empty one
      }
      delete meta["layout"];
      await tx.all(`update "entries" set "meta" = ?, "updated_at" = ? where "id" = ?`, [
        JSON.stringify(meta),
        new Date(now),
        page.id,
      ]);
    }
    await tx.all(`delete from "theme_overrides" where "theme_id" = ? and "template_key" = ?`, [
      themeId,
      key,
    ]);
    await tx.all(
      `delete from "theme_override_versions" where "theme_id" = ? and "template_key" = ?`,
      [themeId, key],
    );
    await tx.all(
      `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id",
        "detail", "created_at") values (?, ?, 'user', ?, 'layout.delete', 'layout', ?, ?, ?)`,
      [
        newId(),
        siteId,
        actor.userId,
        key,
        JSON.stringify({ name: row.name ?? "", themeId, movedPages: moved.map((p) => p.id) }),
        new Date(now),
      ],
    );
  });
  return { ok: true, moved };
}

/** A named layout a page can choose. */
export interface LayoutChoice {
  /** "custom-landing-page" */
  name: string;
  /** "Landing page" */
  title: string;
}

/** The named layouts of the theme in use that pages can choose, by title. */
export async function layoutChoices(runner: SqlRunner, siteId: string): Promise<LayoutChoice[]> {
  const active = await runner.all(
    `select "id" from "themes" where "site_id" = ? and "is_active" = ? and "source" = 'runtime'`,
    [siteId, true],
  );
  if (!active[0]) return [];
  const rows = await runner.all(
    `select "template_key", "name" from "theme_overrides"
      where "theme_id" = ? and "kind" = 'owner-made' and "template_key" like 'templates/custom-%'`,
    [String(active[0]["id"])],
  );
  return rows
    .map((r) => ({
      name: String(r["template_key"]).slice("templates/".length),
      title: String(r["name"]),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** The content types of the site that have no page layout of their own in a theme, for "a layout for a type". */
export async function typesWithoutLayout(
  runner: SqlRunner,
  siteId: string,
  themeId: string,
): Promise<{ key: string; label: string }[]> {
  const found = await loadThemeVersion(runner, siteId, themeId);
  if (!found) return [];
  const rows = await overridesOf(runner, themeId);
  const types = await runner.all(
    `select "key", "label" from "content_types" where "site_id" = ? order by "label"`,
    [siteId],
  );
  return types
    .map((t) => ({ key: String(t["key"]), label: String(t["label"]) }))
    .filter(
      (t) =>
        TYPE.test(t.key) &&
        !rows.has(`templates/${typeLayoutName(t.key)}`) &&
        !found.version.templates.some((l) => l.name === typeLayoutName(t.key)),
    );
}

/** The layout an entry chose and the ones it may choose (the "Layout" box of the edit screen). */
export async function loadEntryLayout(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<ThemeActionResult<{ layout: string; choices: LayoutChoice[] }>> {
  const loaded = await loadForEdit(runner, actor, siteId, id);
  if (!loaded.ok)
    return loaded.code === "forbidden"
      ? { ok: false, code: "forbidden", message: loaded.message }
      : { ok: false, code: "not_found", message: loaded.message };
  const rows = await runner.all(`select "meta" from "entries" where "id" = ? and "site_id" = ?`, [
    id,
    siteId,
  ]);
  return {
    ok: true,
    layout: chosenLayout(rows[0]?.["meta"]),
    choices: await layoutChoices(runner, siteId),
  };
}

/**
 * Chooses a named layout for an entry ("" for its usual one). Only people who may edit the entry, and only a layout of
 * the theme in use. The choice is kept when the site switches theme: a theme without that layout uses the usual one.
 */
export async function setEntryLayout(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  layout: unknown,
  now: number = Date.now(),
): Promise<ThemeActionResult<{ layout: string; slug: string }>> {
  const loaded = await loadForEdit(runner, actor, siteId, id);
  if (!loaded.ok)
    return loaded.code === "forbidden"
      ? { ok: false, code: "forbidden", message: loaded.message }
      : { ok: false, code: "not_found", message: loaded.message };
  if (typeof layout !== "string") return invalid("Choose a layout.");
  if (layout !== "" && !(await layoutChoices(runner, siteId)).some((c) => c.name === layout))
    return invalid("That layout is not one of the theme in use.");
  const rows = await runner.all(
    `select "meta", "slug" from "entries" where "id" = ? and "site_id" = ?`,
    [id, siteId],
  );
  let meta: Record<string, unknown> = {};
  const raw = rows[0]?.["meta"];
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (value && typeof value === "object") meta = { ...(value as Record<string, unknown>) };
  } catch {
    // a damaged value is replaced by an empty one
  }
  if (layout) meta["layout"] = layout;
  else delete meta["layout"];
  await runner.all(
    `update "entries" set "meta" = ?, "updated_at" = ? where "id" = ? and "site_id" = ?`,
    [JSON.stringify(meta), new Date(now), id, siteId],
  );
  return { ok: true, layout, slug: String(rows[0]?.["slug"] ?? "") };
}
