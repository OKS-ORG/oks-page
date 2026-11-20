// Drawing public pages from the layouts of the theme in use (spec 05, section 7). Which layout a page uses follows the
// order in the rendering notes: the most specific one wins ("single-post-hello" → "single-post" → "single" → "index").
// A layout is turned into a "draw tree" here, once: runs of ordinary content blocks are written to HTML by the same
// writer as page content, and site blocks (site title, menu, the page's content...) are left for the site to draw with
// live data. The blocks are checked again when they are read, so a changed row can never put unsafe HTML on a page.
import { checkBlocks, type Block } from "@oks-page/content-safety";
import type { SqlRunner } from "@oks-page/db";
import { writeBlocks } from "@oks-page/renderer";
import { expandLinked, LINKED_SECTION, loadSectionBlocks } from "./saved-sections.js";
import { loadThemeVersion } from "./theme-install.js";
import { SITE_BLOCKS } from "./theme-package.js";

export type DrawNode =
  | { kind: "html"; html: string; id?: string; hide?: Screen[] }
  | {
      kind: "site";
      type: string;
      props: Record<string, unknown>;
      children: DrawNode[];
      id?: string;
      hide?: Screen[];
    };

/**
 * The three screen sizes a block can be hidden on (spec 05, section 17.5; spec 06, PB-97), with the default
 * breakpoints of spec 06, section 4.1: a phone is up to 767 px wide, a tablet 768 to 1024 px, a desktop 1025 px and up.
 */
export const SCREENS = ["phone", "tablet", "desktop"] as const;
export type Screen = (typeof SCREENS)[number];
export const SCREEN_MIN_WIDTH: Record<Screen, number> = { phone: 0, tablet: 768, desktop: 1025 };

/** The screens a block is hidden on, from its `hide` setting: known names only, each once, in order. */
export function hiddenOn(props: Record<string, unknown>): Screen[] {
  const raw = props["hide"];
  if (!Array.isArray(raw)) return [];
  return SCREENS.filter((screen) => raw.includes(screen));
}

export interface ThemeLayouts {
  /** Layouts for whole pages, by name ("index", "single-post", "archive"...). */
  templates: Record<string, DrawNode[]>;
  /** Headers, footers and other parts, by name, included with a `part` block. */
  parts: Record<string, DrawNode[]>;
}

/** What kind of page is being drawn. */
export type PageKind =
  | {
      kind: "entry";
      type: string;
      slug: string;
      /** A layout the page chose in its settings ("custom-landing-page"); used first when the theme has it. */
      chosen?: string;
    }
  | { kind: "archive"; termKind: string }
  /** The public list of a custom type ("shop" for the prefix "shop/"). */
  | { kind: "type-list"; type: string }
  | { kind: "search" }
  /** The list of the newest posts (the home page or the posts page, Settings > Reading). */
  | { kind: "posts" };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SITE = new Set<string>(SITE_BLOCKS);

/** The layout names to try for a page, most specific first. */
export function layoutCandidates(page: PageKind): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    if (NAME.test(name) && !out.includes(name)) out.push(name);
  };
  if (page.kind === "entry") {
    if (page.chosen) add(page.chosen);
    // "/" is the entry with the address "home".
    if (page.slug === "home") add("front-page");
    const slug = page.slug.replaceAll("/", "-");
    if (page.type === "page") {
      add(`page-${slug}`);
      add("page");
    } else {
      add(`single-${page.type}-${slug}`);
      add(`single-${page.type}`);
      add("single");
    }
  } else if (page.kind === "archive") {
    add(page.termKind);
    add("archive");
  } else if (page.kind === "type-list") {
    add(`list-${page.type}`);
    add("archive");
  } else if (page.kind === "posts") add("home");
  else add("search");
  add("index");
  return out;
}

/** The layout an entry chose in its settings (kept in its `meta` as `layout`), or "" for the usual one. */
export function chosenLayout(meta: unknown): string {
  let value = meta;
  if (typeof meta === "string") {
    try {
      value = JSON.parse(meta);
    } catch {
      return "";
    }
  }
  const layout =
    value && typeof value === "object" ? (value as Record<string, unknown>)["layout"] : undefined;
  return typeof layout === "string" && NAME.test(layout) ? layout : "";
}

/** The first layout of the list the theme has, or null (the site then draws the page the built-in way). */
export function pickLayout(layouts: ThemeLayouts | null, candidates: string[]): DrawNode[] | null {
  if (!layouts) return null;
  for (const name of candidates)
    if (Object.hasOwn(layouts.templates, name)) return layouts.templates[name]!;
  return null;
}

/**
 * Turns checked blocks into a draw tree: content runs become HTML, site blocks stay as nodes. With `split` (the site
 * editor's preview), every content block is written on its own and every node keeps its block id, so a click on the
 * preview can say which block it was.
 */
export function toDrawNodes(
  blocks: Block[],
  options: { split?: boolean; sections?: ReadonlyMap<string, Block[]> } = {},
): DrawNode[] {
  // Public pages draw a linked section as its blocks in place, exactly like a copy; the editor keeps it as one block.
  if (!options.split && options.sections) {
    return toDrawNodes(expandLinked(blocks, options.sections));
  }
  const out: DrawNode[] = [];
  let run: Block[] = [];
  let runHide: Screen[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const { html } = writeBlocks(run);
    if (html)
      out.push({
        kind: "html",
        html,
        ...(options.split ? { id: run[0]!.id } : {}),
        ...(runHide.length > 0 ? { hide: runHide } : {}),
      });
    run = [];
    runHide = [];
  };
  for (const block of blocks) {
    const hide = hiddenOn(block.props);
    if (block.type === LINKED_SECTION) {
      flush();
      const id = typeof block.props["id"] === "string" ? block.props["id"] : "";
      const inner = options.sections?.get(id);
      out.push({
        kind: "site",
        type: LINKED_SECTION,
        props: block.props,
        children: inner
          ? toDrawNodes(expandLinked(inner, options.sections!, [id]), {
              split: options.split ?? false,
            })
          : [],
        ...(options.split ? { id: block.id } : {}),
        ...(hide.length > 0 ? { hide } : {}),
      });
    } else if (SITE.has(block.type)) {
      flush();
      out.push({
        kind: "site",
        type: block.type,
        props: block.props,
        // Only a section holds other blocks; the children of other site blocks are not drawn.
        children: block.type === "section" ? toDrawNodes(block.children, options) : [],
        ...(options.split ? { id: block.id } : {}),
        ...(hide.length > 0 ? { hide } : {}),
      });
    } else {
      // A block hidden on some screens is written on its own, so it can be hidden without its neighbours.
      if (hide.length > 0) flush();
      run.push(block);
      runHide = hide;
      if (options.split || hide.length > 0) flush();
    }
  }
  flush();
  return out;
}

/** Stored blocks, checked again, as a draw tree (a ready-made section's picture in the section library). */
export function checkedDrawNodes(blocks: unknown): DrawNode[] {
  return toDrawNodes(checkBlocks({ version: 1, blocks }).body.blocks);
}

const parseStored = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return []; // damaged: drawn as an empty layout, never as raw text
  }
};

export interface LoadLayoutsOptions {
  /** The theme to draw; the theme in use when not given. */
  themeId?: string;
  /** Use the owner's unpublished changes (the site editor's preview). */
  drafts?: boolean;
  /** Keep a block id on every node (the site editor's preview). */
  split?: boolean;
  /** For one layout, draw the theme's own blocks, the published change, or the draft (the compare view). */
  only?: { key: string; use: "theme" | "published" | "draft" };
}

/**
 * The layouts of a theme (the one in use unless `themeId` is given), ready to draw, with the owner's published changes
 * in place of the theme's own (and, with `drafts`, the unpublished ones). Null when there is no such theme or it has
 * no layouts.
 */
export async function loadThemeLayouts(
  runner: SqlRunner,
  siteId: string,
  options: LoadLayoutsOptions = {},
): Promise<ThemeLayouts | null> {
  let themeId = options.themeId;
  if (!themeId) {
    const active = await runner.all(
      `select "id" from "themes" where "site_id" = ? and "is_active" = ? and "source" = 'runtime'`,
      [siteId, true],
    );
    if (!active[0]) return null;
    themeId = String(active[0]["id"]);
  }
  const found = await loadThemeVersion(runner, siteId, themeId);
  if (!found) return null;
  const version = found.version;
  const sections = await loadSectionBlocks(runner, siteId, { drafts: options.drafts ?? false });
  const owner = new Map<string, unknown>();
  const rows = await runner.all(
    `select "template_key", "content", "draft" from "theme_overrides" where "theme_id" = ?`,
    [themeId],
  );
  for (const row of rows) {
    const key = String(row["template_key"]);
    let use = options.drafts ? "draft" : "published";
    if (options.only?.key === key) use = options.only.use;
    if (use === "theme") continue;
    const raw = use === "draft" && row["draft"] != null ? row["draft"] : row["content"];
    if (raw == null) continue;
    owner.set(key, parseStored(raw));
  }
  const build = (folder: string, list: unknown): Record<string, DrawNode[]> => {
    const out: Record<string, DrawNode[]> = {};
    const items = Array.isArray(list) ? (list as { name?: unknown; blocks?: unknown }[]) : [];
    const names = new Set<string>();
    for (const item of items) if (item && typeof item.name === "string") names.add(item.name);
    for (const key of owner.keys())
      if (key.startsWith(`${folder}/`)) names.add(key.slice(folder.length + 1));
    for (const name of names) {
      if (!NAME.test(name)) continue;
      const blocks = owner.has(`${folder}/${name}`)
        ? owner.get(`${folder}/${name}`)
        : items.find((i) => i?.name === name)?.blocks;
      const checked = checkBlocks({ version: 1, blocks });
      out[name] = toDrawNodes(checked.body.blocks, { split: options.split ?? false, sections });
    }
    return out;
  };
  const templates = build("templates", version.templates);
  if (Object.keys(templates).length === 0) return null;
  return { templates, parts: build("parts", version.parts) };
}

/** The layouts of the theme in use, as the public pages draw them (see `loadThemeLayouts`). */
export async function loadActiveThemeLayouts(
  runner: SqlRunner,
  siteId: string,
  options: { drafts?: boolean } = {},
): Promise<ThemeLayouts | null> {
  return loadThemeLayouts(runner, siteId, options);
}

/** The parts a layout draws, directly or through other parts (at most 6 levels, as the checks allow). */
export function partsUsedBy(layout: DrawNode[], parts: Record<string, DrawNode[]>): string[] {
  const used = new Set<string>();
  const walk = (nodes: DrawNode[], depth: number) => {
    for (const node of nodes) {
      if (node.kind !== "site") continue;
      if (node.type === "section") walk(node.children, depth);
      const name = node.props["name"];
      if (
        node.type === "part" &&
        typeof name === "string" &&
        Object.hasOwn(parts, name) &&
        !used.has(name) &&
        depth < 6
      ) {
        used.add(name);
        walk(parts[name]!, depth + 1);
      }
    }
  };
  walk(layout, 0);
  return [...used];
}

/** True when the nodes draw the linked saved section, directly, inside sections, or through parts. */
export function nodesLink(
  nodes: DrawNode[],
  parts: Record<string, DrawNode[]>,
  sectionId: string,
): boolean {
  const walk = (list: DrawNode[], depth: number): boolean =>
    list.some((node) => {
      if (node.kind !== "site") return false;
      if (node.type === LINKED_SECTION && node.props["id"] === sectionId) return true;
      if (node.type === "section" || node.type === LINKED_SECTION)
        return walk(node.children, depth);
      const name = node.props["name"];
      return (
        node.type === "part" &&
        typeof name === "string" &&
        Object.hasOwn(parts, name) &&
        depth < 6 &&
        walk(parts[name]!, depth + 1)
      );
    });
  return walk(nodes, 0);
}

/** Where a layout shows: how many published entries of each type use it, and which other kinds of page do. */
export interface LayoutUsage {
  /** Published entries that use it, by content type ("post": 24). */
  entries: Record<string, number>;
  /** True when category and tag pages use it. */
  archives: boolean;
  /** True when the search page uses it. */
  search: boolean;
  /** For a part: the names of the page layouts that draw it. */
  inLayouts: string[];
}

/** Works out where a layout of the theme shows, with the real number of pages and posts (spec 05, 17.5). */
export async function layoutUsage(
  runner: SqlRunner,
  siteId: string,
  layouts: ThemeLayouts,
  key: string,
): Promise<LayoutUsage> {
  const usage: LayoutUsage = { entries: {}, archives: false, search: false, inLayouts: [] };
  const [folder, name] = key.split("/") as [string, string];
  // The page layouts that count: the layout itself, or (for a part) every layout that draws the part.
  const counting = new Set<string>();
  if (folder === "templates") counting.add(name);
  else if (folder === "sections") {
    // A saved section: every page layout that draws it (the layouts must be loaded with `split`, which keeps links).
    for (const [template, nodes] of Object.entries(layouts.templates))
      if (nodesLink(nodes, layouts.parts, name)) {
        counting.add(template);
        usage.inLayouts.push(template);
      }
  } else
    for (const [template, nodes] of Object.entries(layouts.templates))
      if (partsUsedBy(nodes, layouts.parts).includes(name)) {
        counting.add(template);
        usage.inLayouts.push(template);
      }
  const rows = await runner.all(
    `select "slug", "type_key", "meta" from "entries" where "site_id" = ? and "status" = 'published' and "locale" = ''`,
    [siteId],
  );
  for (const row of rows) {
    const type = String(row["type_key"]);
    const chosen = layoutCandidates({
      kind: "entry",
      type,
      slug: String(row["slug"]),
      chosen: chosenLayout(row["meta"]),
    }).find((n) => Object.hasOwn(layouts.templates, n));
    if (chosen && counting.has(chosen)) usage.entries[type] = (usage.entries[type] ?? 0) + 1;
  }
  const first = (kind: PageKind) =>
    layoutCandidates(kind).find((n) => Object.hasOwn(layouts.templates, n));
  for (const termKind of ["category", "tag"]) {
    const chosen = first({ kind: "archive", termKind });
    if (chosen && counting.has(chosen)) usage.archives = true;
  }
  const chosen = first({ kind: "search" });
  if (chosen && counting.has(chosen)) usage.search = true;
  return usage;
}
