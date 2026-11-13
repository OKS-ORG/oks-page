// Drawing public pages from the layouts of the theme in use (spec 05, section 7). Which layout a page uses follows the
// order in the rendering notes: the most specific one wins ("single-post-hello" → "single-post" → "single" → "index").
// A layout is turned into a "draw tree" here, once: runs of ordinary content blocks are written to HTML by the same
// writer as page content, and site blocks (site title, menu, the page's content...) are left for the site to draw with
// live data. The blocks are checked again when they are read, so a changed row can never put unsafe HTML on a page.
import { checkBlocks, type Block } from "@oks-page/content-safety";
import type { SqlRunner } from "@oks-page/db";
import { writeBlocks } from "@oks-page/renderer";
import { loadActiveThemeVersion } from "./theme-install.js";
import { SITE_BLOCKS } from "./theme-package.js";

export type DrawNode =
  | { kind: "html"; html: string }
  | { kind: "site"; type: string; props: Record<string, unknown>; children: DrawNode[] };

export interface ThemeLayouts {
  /** Layouts for whole pages, by name ("index", "single-post", "archive"...). */
  templates: Record<string, DrawNode[]>;
  /** Headers, footers and other parts, by name, included with a `part` block. */
  parts: Record<string, DrawNode[]>;
}

/** What kind of page is being drawn. */
export type PageKind =
  | { kind: "entry"; type: string; slug: string }
  | { kind: "archive"; termKind: string }
  | { kind: "search" };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SITE = new Set<string>(SITE_BLOCKS);

/** The layout names to try for a page, most specific first. */
export function layoutCandidates(page: PageKind): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    if (NAME.test(name) && !out.includes(name)) out.push(name);
  };
  if (page.kind === "entry") {
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
  } else add("search");
  add("index");
  return out;
}

/** The first layout of the list the theme has, or null (the site then draws the page the built-in way). */
export function pickLayout(layouts: ThemeLayouts | null, candidates: string[]): DrawNode[] | null {
  if (!layouts) return null;
  for (const name of candidates)
    if (Object.hasOwn(layouts.templates, name)) return layouts.templates[name]!;
  return null;
}

/** Turns checked blocks into a draw tree: content runs become HTML, site blocks stay as nodes. */
export function toDrawNodes(blocks: Block[]): DrawNode[] {
  const out: DrawNode[] = [];
  let run: Block[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const { html } = writeBlocks(run);
    if (html) out.push({ kind: "html", html });
    run = [];
  };
  for (const block of blocks) {
    if (SITE.has(block.type)) {
      flush();
      out.push({
        kind: "site",
        type: block.type,
        props: block.props,
        // Only a section holds other blocks; the children of other site blocks are not drawn.
        children: block.type === "section" ? toDrawNodes(block.children) : [],
      });
    } else run.push(block);
  }
  flush();
  return out;
}

/** The layouts of the theme in use, ready to draw; null when no theme is in use or it has no layouts. */
export async function loadActiveThemeLayouts(
  runner: SqlRunner,
  siteId: string,
): Promise<ThemeLayouts | null> {
  const version = await loadActiveThemeVersion(runner, siteId);
  if (!version) return null;
  const build = (list: unknown): Record<string, DrawNode[]> => {
    const out: Record<string, DrawNode[]> = {};
    if (!Array.isArray(list)) return out;
    for (const item of list as { name?: unknown; blocks?: unknown }[]) {
      if (!item || typeof item.name !== "string" || !NAME.test(item.name)) continue;
      const checked = checkBlocks({ version: 1, blocks: item.blocks });
      out[item.name] = toDrawNodes(checked.body.blocks);
    }
    return out;
  };
  const templates = build(version.templates);
  if (Object.keys(templates).length === 0) return null;
  return { templates, parts: build(version.parts) };
}
