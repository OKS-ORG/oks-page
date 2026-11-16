// Saved sections (spec 05, sections 17.6 and 17.10; D127). The owner saves a section by name ("Opening hours box"); it
// belongs to the site, not the theme, so it survives a theme switch, and shows in the section library under "My
// sections". Each time it is placed, the owner chooses a Copy (changed in that place only) or Linked: a `linked-section`
// block that stores only the saved section's id, so the section is the same everywhere it is placed. Changes to a saved
// section stay a draft until Publish, like layout changes, and the last 20 published versions are kept. Deleting one
// that is still linked first turns every placement into a copy, so no page changes.
import { checkBlocks, type Block } from "@oks-page/content-safety";
import { newId, type SqlRunner } from "@oks-page/db";
import { writeBlocks } from "@oks-page/renderer";
import type { Actor } from "./content.js";
import type { ThemeActionResult } from "./theme-install.js";
import { MAX_PART_DEPTH, SITE_BLOCKS, sectionGroup, type SectionGroup } from "./theme-package.js";

/** The block that places a saved section by reference. */
export const LINKED_SECTION = "linked-section";
/** How many published versions of each saved section are kept. */
export const SECTION_HISTORY = 20;
export const SECTION_NAME_MAX = 80;
/** A saved section can hold at most this many blocks (a layout may hold 5,000 once everything is in place). */
export const SECTION_MAX_BLOCKS = 1000;

export interface SavedSectionInfo {
  id: string;
  name: string;
  group: SectionGroup;
  /** True when there are changes not published yet. */
  hasDraft: boolean;
  updatedAt: number;
}

export interface SavedSectionDetail extends SavedSectionInfo {
  published: Block[];
  draft: Block[] | null;
}

/** A layout that places a saved section as a linked section (published or in a draft). */
export interface SectionPlace {
  themeId: string;
  /** "templates/<name>" or "parts/<name>", or "sections/<id>" for another saved section. */
  key: string;
}

export interface SectionVersion {
  id: string;
  publishedAt: number;
  publishedBy: string;
}

const forbidden = {
  ok: false,
  code: "forbidden",
  message: "You may not change the site design.",
} as const;
const notFound = {
  ok: false,
  code: "not_found",
  message: "That saved section does not exist.",
} as const;
const invalid = (message: string) => ({ ok: false, code: "invalid", message }) as const;

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
const time = (raw: unknown): number => new Date(raw as string | number | Date).getTime();

// ----- pure rules

/** The ids of the saved sections a list of blocks links to, anywhere inside, each once. */
export function linkedIds(blocks: Block[]): string[] {
  const out = new Set<string>();
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.type === LINKED_SECTION && typeof b.props["id"] === "string") out.add(b.props["id"]);
      walk(b.children);
    }
  };
  walk(blocks);
  return [...out];
}

const count = (blocks: Block[]): number => blocks.reduce((n, b) => n + 1 + count(b.children), 0);

/**
 * What is wrong with a set of saved sections, in plain words: a section that links to itself, directly or through
 * another linked section (TH-79); linking deeper than 6 levels; a link to a section that does not exist; too many blocks.
 */
export function linkProblems(sections: Map<string, { name: string; blocks: Block[] }>): string[] {
  const problems: string[] = [];
  for (const [id, section] of sections) {
    if (count(section.blocks) > SECTION_MAX_BLOCKS)
      problems.push(`"${section.name}" has more than ${SECTION_MAX_BLOCKS} blocks.`);
    let loop = false;
    let deep = false;
    const walk = (ids: string[], depth: number, seen: string[]) => {
      for (const next of ids) {
        if (loop || deep) return;
        if (next === id) {
          loop = true;
          return;
        }
        const found = sections.get(next);
        if (!found || seen.includes(next)) continue;
        if (depth >= MAX_PART_DEPTH) {
          deep = true;
          return;
        }
        walk(linkedIds(found.blocks), depth + 1, [...seen, next]);
      }
    };
    walk(linkedIds(section.blocks), 1, []);
    if (loop)
      problems.push(
        `"${section.name}" contains itself, directly or through another linked section. A section cannot hold itself.`,
      );
    else if (deep)
      problems.push(`"${section.name}" links sections more than ${MAX_PART_DEPTH} levels deep.`);
    for (const missing of linkedIds(section.blocks).filter((x) => !sections.has(x)))
      problems.push(
        `"${section.name}" links to a saved section that no longer exists (${missing}).`,
      );
  }
  return problems;
}

/** The links in a layout to saved sections that do not exist, in plain words. */
export function missingLinks(key: string, blocks: Block[], existing: Set<string>): string[] {
  return linkedIds(blocks)
    .filter((id) => !existing.has(id))
    .map((id) => `${key}: a linked section that no longer exists (${id}). Remove it or detach it.`);
}

/**
 * Puts the blocks of each linked section in its place, as public pages draw them. The blocks are the same as a copy's
 * would be (only ids differ, and ids are never written to the page), so a linked section and a copy of it give the same
 * HTML. "Hide on phone, tablet or desktop" set on the linked block is given to each block put in its place. A link to a
 * section that does not exist, that loops, or that goes deeper than 6 levels draws nothing.
 */
export function expandLinked(
  blocks: Block[],
  sections: ReadonlyMap<string, Block[]>,
  stack: string[] = [],
): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type !== LINKED_SECTION) {
      out.push(
        b.children.length > 0 ? { ...b, children: expandLinked(b.children, sections, stack) } : b,
      );
      continue;
    }
    const id = typeof b.props["id"] === "string" ? b.props["id"] : "";
    const found = sections.get(id);
    if (!found || stack.includes(id) || stack.length >= MAX_PART_DEPTH) continue;
    const hide = Array.isArray(b.props["hide"]) ? (b.props["hide"] as unknown[]) : [];
    for (const inner of expandLinked(found, sections, [...stack, id])) {
      if (hide.length === 0) {
        out.push(inner);
        continue;
      }
      const own = Array.isArray(inner.props["hide"]) ? (inner.props["hide"] as unknown[]) : [];
      out.push({ ...inner, props: { ...inner.props, hide: [...new Set([...own, ...hide])] } });
    }
  }
  return out;
}

const randomId = (taken: Set<string>): string => {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10);
    if (id.length === 8 && !taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
};
const allIds = (blocks: Block[], into = new Set<string>()): Set<string> => {
  for (const b of blocks) {
    into.add(b.id);
    allIds(b.children, into);
  }
  return into;
};
const withNewIds = (block: Block, taken: Set<string>): Block => ({
  ...block,
  id: randomId(taken),
  children: block.children.map((c) => withNewIds(c, taken)),
});

/**
 * "Detach": every link to the section in a list of blocks becomes a copy of the section's blocks (with new ids, and
 * the linked block's hiding given to each), so the list draws exactly as before.
 */
export function detachLinks(blocks: Block[], sectionId: string, sectionBlocks: Block[]): Block[] {
  const taken = allIds(blocks);
  const walk = (list: Block[]): Block[] =>
    list.flatMap((b) => {
      if (b.type === LINKED_SECTION && b.props["id"] === sectionId) {
        const hide = Array.isArray(b.props["hide"]) ? (b.props["hide"] as unknown[]) : [];
        return sectionBlocks.map((s) => {
          const copy = withNewIds(s, taken);
          if (hide.length === 0) return copy;
          const own = Array.isArray(copy.props["hide"]) ? (copy.props["hide"] as unknown[]) : [];
          return { ...copy, props: { ...copy.props, hide: [...new Set([...own, ...hide])] } };
        });
      }
      return [{ ...b, children: walk(b.children) }];
    });
  return walk(blocks);
}

// ----- saved sections inside page content (spec 05, 17.10)
//
// A page or post keeps its blocks, and its HTML and text written when it was saved. A linked section is put in place
// before that writing, so the page shows the section and search finds its words. When a section is published the
// pages that link to it are written again (`rewriteLinkedEntries`); when it is deleted they get a copy first.

/** Blocks only a page layout can show: the site blocks, which need a theme to be drawn. */
const LAYOUT_ONLY = new Set<string>(SITE_BLOCKS.filter((t) => t !== LINKED_SECTION));
const holdsLayoutOnly = (blocks: Block[]): boolean =>
  blocks.some((b) => LAYOUT_ONLY.has(b.type) || holdsLayoutOnly(b.children));

/**
 * The published sections a page's blocks link to, ready to draw, or what is wrong in plain words: a section that no
 * longer exists, or one that holds parts only a layout can show. A page with no links costs nothing.
 */
export async function sectionsForContent(
  runner: SqlRunner,
  siteId: string,
  blocks: Block[],
): Promise<{ ok: true; sections: Map<string, Block[]> } | { ok: false; message: string }> {
  // A block that has not been given a section yet (the editor shows a list to choose from) draws nothing.
  const ids = linkedIds(blocks).filter((id) => id !== "");
  if (ids.length === 0) return { ok: true, sections: new Map() };
  const rows = await rowsOf(runner, siteId);
  const sections = new Map([...rows.values()].map((r) => [r.id, r.published]));
  const problems: string[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) {
      problems.push("A saved section used on this page no longer exists. Take it off the page.");
      continue;
    }
    if (holdsLayoutOnly(expandLinked(row.published, sections, [id])))
      problems.push(
        `"${row.name}" holds parts that only a page layout can show, so it cannot be placed in page content.`,
      );
  }
  return problems.length > 0 ? { ok: false, message: problems.join(" ") } : { ok: true, sections };
}

/** The HTML and the text of page content, with the linked sections in place. */
export const writeContentBlocks = (blocks: Block[], sections: ReadonlyMap<string, Block[]>) =>
  writeBlocks(expandLinked(blocks, sections));

export interface InsertableSection {
  id: string;
  name: string;
  group: SectionGroup;
  /** The published blocks, for placing a copy. */
  blocks: Block[];
}

/** The saved sections that page content can hold (not empty, nothing only a layout can show), by name. */
export async function insertableSections(
  runner: SqlRunner,
  siteId: string,
): Promise<InsertableSection[]> {
  const rows = await rowsOf(runner, siteId);
  const sections = new Map([...rows.values()].map((r) => [r.id, r.published]));
  return [...rows.values()]
    .filter(
      (r) =>
        r.published.length > 0 && !holdsLayoutOnly(expandLinked(r.published, sections, [r.id])),
    )
    .map((r) => ({ id: r.id, name: r.name, group: r.group, blocks: r.published }));
}

/** A page or post that links to a saved section. */
export interface EntryUse {
  id: string;
  /** "page", "post" or another content type. */
  type: string;
  slug: string;
  title: string;
}

interface LinkingEntry extends EntryUse {
  blocks: Block[];
  html: string;
}

async function entriesWithLinks(runner: SqlRunner, siteId: string): Promise<LinkingEntry[]> {
  const rows = await runner.all(
    `select "id", "type_key", "slug", "title", "body", "html" from "entries"
      where "site_id" = ? and "status" <> 'trash' and cast("body" as text) like ?`,
    [siteId, `%${LINKED_SECTION}%`],
  );
  const out: LinkingEntry[] = [];
  for (const r of rows) {
    const value = readJson(r["body"]);
    const list = Array.isArray(value) ? value : (value as { blocks?: unknown } | null)?.blocks;
    const blocks = checkBlocks({ version: 1, blocks: list ?? [] }).body.blocks;
    if (linkedIds(blocks).length === 0) continue;
    out.push({
      id: String(r["id"]),
      type: String(r["type_key"]),
      slug: String(r["slug"]),
      title: String(r["title"]),
      blocks,
      html: String(r["html"] ?? ""),
    });
  }
  return out;
}

/** The pages and posts that link to a saved section, by title. */
export async function entriesLinking(
  runner: SqlRunner,
  siteId: string,
  id: string,
): Promise<EntryUse[]> {
  return (await entriesWithLinks(runner, siteId))
    .filter((e) => linkedIds(e.blocks).includes(id))
    .map(({ id: entryId, type, slug, title }) => ({ id: entryId, type, slug, title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Writes the HTML and text again for every page and post that links to a saved section, from the sections as published
 * now. A page whose HTML does not change is left alone. Returns the pages changed (their caches must be refreshed).
 */
export async function rewriteLinkedEntries(tx: SqlRunner, siteId: string): Promise<EntryUse[]> {
  const sections = await loadSectionBlocks(tx, siteId);
  const changed: EntryUse[] = [];
  for (const e of await entriesWithLinks(tx, siteId)) {
    const written = writeContentBlocks(e.blocks, sections);
    if (written.html === e.html) continue;
    await tx.all(`update "entries" set "html" = ?, "plain_text" = ? where "id" = ?`, [
      written.html,
      written.plainText,
      e.id,
    ]);
    changed.push({ id: e.id, type: e.type, slug: e.slug, title: e.title });
  }
  return changed;
}

// ----- stored sections

interface Row {
  id: string;
  name: string;
  group: SectionGroup;
  published: Block[];
  draft: Block[] | null;
  updatedAt: number;
}

async function rowsOf(runner: SqlRunner, siteId: string): Promise<Map<string, Row>> {
  const rows = await runner.all(
    `select "id", "name", "section_group", "content", "draft", "updated_at" from "saved_sections"
      where "site_id" = ? order by "name"`,
    [siteId],
  );
  const out = new Map<string, Row>();
  for (const r of rows)
    out.set(String(r["id"]), {
      id: String(r["id"]),
      name: String(r["name"]),
      group: sectionGroup(r["section_group"]),
      published: blocksOf(r["content"]) ?? [],
      draft: blocksOf(r["draft"]),
      updatedAt: time(r["updated_at"]),
    });
  return out;
}

const infoOf = (r: Row): SavedSectionInfo => ({
  id: r.id,
  name: r.name,
  group: r.group,
  hasDraft: r.draft !== null,
  updatedAt: r.updatedAt,
});

/** The blocks of every saved section of the site, for drawing: the published ones, or (with drafts) the drafts. */
export async function loadSectionBlocks(
  runner: SqlRunner,
  siteId: string,
  options: { drafts?: boolean } = {},
): Promise<Map<string, Block[]>> {
  const out = new Map<string, Block[]>();
  for (const r of (await rowsOf(runner, siteId)).values())
    out.set(r.id, options.drafts ? (r.draft ?? r.published) : r.published);
  return out;
}

/** The ids of the site's saved sections. */
export async function savedSectionIds(runner: SqlRunner, siteId: string): Promise<Set<string>> {
  const rows = await runner.all(`select "id" from "saved_sections" where "site_id" = ?`, [siteId]);
  return new Set(rows.map((r) => String(r["id"])));
}

/** Every saved section as it would be published now (drafts first), for the checks. */
const effective = (rows: Map<string, Row>) =>
  new Map([...rows.values()].map((r) => [r.id, { name: r.name, blocks: r.draft ?? r.published }]));

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.replace(/\s+/g, " ").trim();
  return trimmed.length >= 1 && trimmed.length <= SECTION_NAME_MAX ? trimmed : null;
}

const taken = (rows: Map<string, Row>, name: string, except?: string) =>
  [...rows.values()].some((r) => r.id !== except && r.name.toLowerCase() === name.toLowerCase());

/** The saved sections of the site, by name. */
export async function listSavedSections(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
): Promise<ThemeActionResult<{ sections: SavedSectionInfo[] }>> {
  if (!actor.can("themes.manage")) return forbidden;
  return { ok: true, sections: [...(await rowsOf(runner, siteId)).values()].map(infoOf) };
}

/** Every layout (of any installed theme) and saved section that links to a saved section, published or in a draft. */
export async function sectionPlaces(
  runner: SqlRunner,
  siteId: string,
  id: string,
): Promise<SectionPlace[]> {
  const rows = await runner.all(
    `select o."theme_id", o."template_key", o."content", o."draft" from "theme_overrides" o
      join "themes" t on t."id" = o."theme_id" where t."site_id" = ? order by o."template_key"`,
    [siteId],
  );
  const out: SectionPlace[] = [];
  for (const r of rows) {
    const blocks = [...(blocksOf(r["content"]) ?? []), ...(blocksOf(r["draft"]) ?? [])];
    if (linkedIds(blocks).includes(id))
      out.push({ themeId: String(r["theme_id"]), key: String(r["template_key"]) });
  }
  for (const s of (await rowsOf(runner, siteId)).values())
    if (s.id !== id && linkedIds([...s.published, ...(s.draft ?? [])]).includes(id))
      out.push({ themeId: "", key: `sections/${s.id}` });
  return out;
}

/** One saved section with its published blocks, its draft and where it is linked. */
export async function getSavedSection(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<ThemeActionResult<{ section: SavedSectionDetail; places: SectionPlace[] }>> {
  if (!actor.can("themes.manage")) return forbidden;
  const row = (await rowsOf(runner, siteId)).get(id);
  if (!row) return notFound;
  return {
    ok: true,
    section: { ...infoOf(row), published: row.published, draft: row.draft },
    places: await sectionPlaces(runner, siteId, id),
  };
}

/**
 * Saves blocks as a new section, published at once (it is shown nowhere until it is placed). The blocks are checked
 * like page content, and the name must be new on this site.
 */
export async function createSavedSection(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: { name: unknown; group?: unknown; blocks: unknown },
  now: number = Date.now(),
): Promise<ThemeActionResult<{ section: SavedSectionInfo; repairs: number }>> {
  if (!actor.can("themes.manage")) return forbidden;
  const name = cleanName(input.name);
  if (!name) return invalid(`Give the section a name of 1 to ${SECTION_NAME_MAX} characters.`);
  if (!Array.isArray(input.blocks) || input.blocks.length === 0)
    return invalid("A section must hold at least one block.");
  const rows = await rowsOf(runner, siteId);
  if (taken(rows, name)) return invalid(`There is already a saved section called "${name}".`);
  const checked = checkBlocks({ version: 1, blocks: input.blocks });
  const id = newId();
  const all = effective(rows);
  all.set(id, { name, blocks: checked.body.blocks });
  const problems = linkProblems(all);
  if (problems.length > 0) return invalid(problems.join(" "));
  const group = sectionGroup(input.group);
  const value = JSON.stringify(checked.body.blocks);
  await runner.transaction(async (tx) => {
    await tx.all(
      `insert into "saved_sections" ("id", "site_id", "name", "section_group", "content", "draft", "created_by",
        "created_at", "updated_at") values (?, ?, ?, ?, ?, null, ?, ?, ?)`,
      [id, siteId, name, group, value, actor.userId, new Date(now), new Date(now)],
    );
    await tx.all(
      `insert into "saved_section_versions" ("id", "section_id", "content", "published_at", "published_by")
        values (?, ?, ?, ?, ?)`,
      [newId(), id, value, new Date(now), actor.userId],
    );
  });
  return {
    ok: true,
    section: { id, name, group, hasDraft: false, updatedAt: now },
    repairs: checked.repairs.length,
  };
}

/** Renames a saved section or moves it to another group (at once; the blocks are not touched). */
export async function updateSavedSection(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  input: { name?: unknown; group?: unknown },
  now: number = Date.now(),
): Promise<ThemeActionResult<{ section: SavedSectionInfo }>> {
  if (!actor.can("themes.manage")) return forbidden;
  const rows = await rowsOf(runner, siteId);
  const row = rows.get(id);
  if (!row) return notFound;
  const name = input.name === undefined ? row.name : cleanName(input.name);
  if (!name) return invalid(`Give the section a name of 1 to ${SECTION_NAME_MAX} characters.`);
  if (taken(rows, name, id)) return invalid(`There is already a saved section called "${name}".`);
  const group = input.group === undefined ? row.group : sectionGroup(input.group);
  await runner.all(
    `update "saved_sections" set "name" = ?, "section_group" = ?, "updated_at" = ? where "id" = ? and "site_id" = ?`,
    [name, group, new Date(now), id, siteId],
  );
  return { ok: true, section: { ...infoOf(row), name, group, updatedAt: now } };
}

/** Keeps changes to a saved section as a draft; visitors see the published one until Publish. */
export async function saveSectionDraft(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  blocks: unknown,
  now: number = Date.now(),
): Promise<ThemeActionResult<{ section: SavedSectionInfo; repairs: number }>> {
  if (!actor.can("themes.manage")) return forbidden;
  const rows = await rowsOf(runner, siteId);
  const row = rows.get(id);
  if (!row) return notFound;
  if (!Array.isArray(blocks) || blocks.length === 0)
    return invalid("A section must hold at least one block. To remove it, delete it.");
  const checked = checkBlocks({ version: 1, blocks });
  const all = effective(rows);
  all.set(id, { name: row.name, blocks: checked.body.blocks });
  const problems = linkProblems(all);
  if (problems.length > 0) return invalid(problems.join(" "));
  await runner.all(
    `update "saved_sections" set "draft" = ?, "updated_at" = ? where "id" = ? and "site_id" = ?`,
    [JSON.stringify(checked.body.blocks), new Date(now), id, siteId],
  );
  return {
    ok: true,
    section: { ...infoOf(row), hasDraft: true, updatedAt: now },
    repairs: checked.repairs.length,
  };
}

/** Throws away the draft of a saved section. */
export async function discardSectionDraft(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<ThemeActionResult<object>> {
  if (!actor.can("themes.manage")) return forbidden;
  await runner.all(`update "saved_sections" set "draft" = null where "id" = ? and "site_id" = ?`, [
    id,
    siteId,
  ]);
  return { ok: true };
}

/** The problems the site's saved sections would have if every draft were published now. */
export async function sectionProblems(runner: SqlRunner, siteId: string): Promise<string[]> {
  return linkProblems(effective(await rowsOf(runner, siteId)));
}

/**
 * Publishes the drafts of every saved section, inside the caller's transaction (Publish publishes layouts and sections
 * at once). Each gets a version in the history, which keeps the newest 20. Returns the ids published.
 */
export async function publishSectionDrafts(
  tx: SqlRunner,
  actor: Actor,
  siteId: string,
  now: number,
): Promise<string[]> {
  const rows = [...(await rowsOf(tx, siteId)).values()].filter((r) => r.draft);
  for (const r of rows) {
    const value = JSON.stringify(r.draft);
    await tx.all(
      `update "saved_sections" set "content" = ?, "draft" = null, "updated_at" = ? where "id" = ?`,
      [value, new Date(now), r.id],
    );
    await tx.all(
      `insert into "saved_section_versions" ("id", "section_id", "content", "published_at", "published_by")
        values (?, ?, ?, ?, ?)`,
      [newId(), r.id, value, new Date(now), actor.userId],
    );
    const old = await tx.all(
      `select "id" from "saved_section_versions" where "section_id" = ? order by "published_at" desc, "id" desc`,
      [r.id],
    );
    for (const extra of old.slice(SECTION_HISTORY))
      await tx.all(`delete from "saved_section_versions" where "id" = ?`, [extra["id"]]);
  }
  return rows.map((r) => r.id);
}

/** The published versions of a saved section, newest first. */
export async function listSectionVersions(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<ThemeActionResult<{ versions: SectionVersion[] }>> {
  if (!actor.can("themes.manage")) return forbidden;
  const rows = await runner.all(
    `select v."id", v."published_at", u."name" from "saved_section_versions" v
      join "saved_sections" s on s."id" = v."section_id"
      left join "users" u on u."id" = v."published_by"
      where s."site_id" = ? and v."section_id" = ? order by v."published_at" desc, v."id" desc`,
    [siteId, id],
  );
  return {
    ok: true,
    versions: rows.map((r) => ({
      id: String(r["id"]),
      publishedAt: time(r["published_at"]),
      publishedBy: r["name"] == null ? "" : String(r["name"]),
    })),
  };
}

/** Makes a new draft from a published version of a saved section. */
export async function restoreSectionVersion(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  versionId: string,
  now: number = Date.now(),
): Promise<ThemeActionResult<{ section: SavedSectionInfo; repairs: number }>> {
  if (!actor.can("themes.manage")) return forbidden;
  const row = (
    await runner.all(
      `select v."section_id", v."content" from "saved_section_versions" v
        join "saved_sections" s on s."id" = v."section_id" where v."id" = ? and s."site_id" = ?`,
      [versionId, siteId],
    )
  )[0];
  if (!row) return { ok: false, code: "not_found", message: "That version does not exist." };
  return saveSectionDraft(
    runner,
    actor,
    siteId,
    String(row["section_id"]),
    blocksOf(row["content"]) ?? [],
    now,
  );
}

/**
 * Deletes a saved section (TH-78). Every place that links to it, in any theme's layouts (published and draft) and in
 * other saved sections, first gets a copy of its published blocks instead, so every page looks exactly the same
 * afterwards. All in one transaction, written to the audit log.
 */
export async function deleteSavedSection(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  now: number = Date.now(),
): Promise<ThemeActionResult<{ copied: SectionPlace[]; entries: EntryUse[] }>> {
  if (!actor.can("themes.manage")) return forbidden;
  const rows = await rowsOf(runner, siteId);
  const row = rows.get(id);
  if (!row) return notFound;
  const places = await sectionPlaces(runner, siteId, id);
  const uses = await entriesWithLinks(runner, siteId);
  const pages = uses.filter((e) => linkedIds(e.blocks).includes(id));
  await runner.transaction(async (tx) => {
    for (const place of places) {
      if (place.key.startsWith("sections/")) {
        const other = rows.get(place.key.slice("sections/".length))!;
        await tx.all(`update "saved_sections" set "content" = ?, "draft" = ? where "id" = ?`, [
          JSON.stringify(detachLinks(other.published, id, row.published)),
          other.draft ? JSON.stringify(detachLinks(other.draft, id, row.published)) : null,
          other.id,
        ]);
        continue;
      }
      const stored = (
        await tx.all(
          `select "content", "draft" from "theme_overrides" where "theme_id" = ? and "template_key" = ?`,
          [place.themeId, place.key],
        )
      )[0]!;
      const content = blocksOf(stored["content"]);
      const draft = blocksOf(stored["draft"]);
      await tx.all(
        `update "theme_overrides" set "content" = ?, "draft" = ? where "theme_id" = ? and "template_key" = ?`,
        [
          content ? JSON.stringify(detachLinks(content, id, row.published)) : null,
          draft ? JSON.stringify(detachLinks(draft, id, row.published)) : null,
          place.themeId,
          place.key,
        ],
      );
    }
    // Pages and posts keep what they show: the link becomes a copy of the published blocks (their HTML does not change).
    for (const page of pages)
      await tx.all(`update "entries" set "body" = ? where "id" = ?`, [
        JSON.stringify({ version: 1, blocks: detachLinks(page.blocks, id, row.published) }),
        page.id,
      ]);
    await tx.all(`delete from "saved_sections" where "id" = ? and "site_id" = ?`, [id, siteId]);
    await tx.all(
      `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id",
        "detail", "created_at") values (?, ?, 'user', ?, 'saved_section.delete', 'saved_section', ?, ?, ?)`,
      [
        newId(),
        siteId,
        actor.userId,
        id,
        JSON.stringify({
          name: row.name,
          copiedInto: [...places.map((p) => p.key), ...pages.map((p) => `entries/${p.id}`)],
        }),
        new Date(now),
      ],
    );
  });
  return {
    ok: true,
    copied: places,
    entries: pages.map(({ id: entryId, type, slug, title }) => ({
      id: entryId,
      type,
      slug,
      title,
    })),
  };
}
