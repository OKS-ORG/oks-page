// The site editor's changes to a layout, as pure functions on the block tree: find, move, duplicate, delete, add, change
// settings, and plain names for the outline (spec 05, sections 17.2 and 17.5). Only sections hold other blocks here.
// Nothing here is trusted by the server: every draft is checked again when it is saved.

export interface LayoutBlock {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content: unknown;
  children: LayoutBlock[];
}

/** A new block id: short, random, and different from every id in the layout. */
export function newBlockId(taken: Set<string> = new Set()): string {
  for (;;) {
    const id = `b${Math.random().toString(36).slice(2, 12)}`;
    if (!taken.has(id)) return id;
  }
}

export function allIds(blocks: LayoutBlock[], out: Set<string> = new Set()): Set<string> {
  for (const b of blocks) {
    out.add(b.id);
    allIds(b.children, out);
  }
  return out;
}

export function findBlock(blocks: LayoutBlock[], id: string): LayoutBlock | null {
  for (const b of blocks) {
    if (b.id === id) return b;
    const inside = findBlock(b.children, id);
    if (inside) return inside;
  }
  return null;
}

/** Applies `change` to the list that holds the block (top level or a section's children); the rest is unchanged. */
function inList(
  blocks: LayoutBlock[],
  id: string,
  change: (list: LayoutBlock[], index: number) => LayoutBlock[],
): LayoutBlock[] {
  const index = blocks.findIndex((b) => b.id === id);
  if (index >= 0) return change(blocks, index);
  return blocks.map((b) =>
    b.children.length > 0 ? { ...b, children: inList(b.children, id, change) } : b,
  );
}

export function moveBlock(blocks: LayoutBlock[], id: string, by: -1 | 1): LayoutBlock[] {
  return inList(blocks, id, (list, index) => {
    const to = index + by;
    if (to < 0 || to >= list.length) return list;
    const next = list.slice();
    [next[index], next[to]] = [next[to]!, next[index]!];
    return next;
  });
}

export function removeBlock(blocks: LayoutBlock[], id: string): LayoutBlock[] {
  return inList(blocks, id, (list, index) => list.filter((_, i) => i !== index));
}

/** A copy with new ids for the block and everything inside it. */
export function copyWithNewIds(block: LayoutBlock, taken: Set<string>): LayoutBlock {
  const id = newBlockId(taken);
  taken.add(id);
  return {
    ...structuredClone(block),
    id,
    children: block.children.map((c) => copyWithNewIds(c, taken)),
  };
}

export function duplicateBlock(
  blocks: LayoutBlock[],
  id: string,
): { blocks: LayoutBlock[]; id: string } {
  const taken = allIds(blocks);
  let copyId = "";
  const next = inList(blocks, id, (list, index) => {
    const copy = copyWithNewIds(list[index]!, taken);
    copyId = copy.id;
    return [...list.slice(0, index + 1), copy, ...list.slice(index + 1)];
  });
  return { blocks: next, id: copyId };
}

/**
 * Adds blocks after the block `afterId`. When that block is a section, they go inside it, at its end. With no block
 * given (or one that is not found), they go at the end of the layout.
 */
export function insertBlocks(
  blocks: LayoutBlock[],
  afterId: string | null,
  added: LayoutBlock[],
): LayoutBlock[] {
  const target = afterId ? findBlock(blocks, afterId) : null;
  if (!target) return [...blocks, ...added];
  if (target.type === "section")
    return replaceBlock(blocks, target.id, [
      { ...target, children: [...target.children, ...added] },
    ]);
  return inList(blocks, target.id, (list, index) => [
    ...list.slice(0, index + 1),
    ...added,
    ...list.slice(index + 1),
  ]);
}

/** Puts the given blocks in the place of one block (an edited text may become several blocks). */
export function replaceBlock(
  blocks: LayoutBlock[],
  id: string,
  replacement: LayoutBlock[],
): LayoutBlock[] {
  return inList(blocks, id, (list, index) => [
    ...list.slice(0, index),
    ...replacement,
    ...list.slice(index + 1),
  ]);
}

export function setProps(
  blocks: LayoutBlock[],
  id: string,
  props: Record<string, unknown>,
): LayoutBlock[] {
  return inList(blocks, id, (list, index) =>
    list.map((b, i) => (i === index ? { ...b, props: { ...b.props, ...props } } : b)),
  );
}

/** The text of a content block, for the outline ("Text: Opening hours..."). */
function firstWords(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const words = content
    .map((item: unknown) => {
      const it = item as { text?: unknown; content?: unknown };
      if (typeof it.text === "string") return it.text;
      return firstWords(it.content);
    })
    .join("")
    .trim();
  return words.length > 40 ? `${words.slice(0, 40)}…` : words;
}

const SITE_NAMES: Record<string, string> = {
  "site-title": "Site name",
  "site-logo": "Logo",
  "post-title": "Page title",
  "post-content": "Page content",
  "post-meta": "Date and author",
  "post-featured-image": "Featured picture",
  "query-loop": "Latest posts",
  pagination: "Page numbers",
  "search-form": "Search box",
  breadcrumbs: "Breadcrumbs",
};
const CONTENT_NAMES: Record<string, string> = {
  paragraph: "Text",
  heading: "Heading",
  quote: "Quote",
  callout: "Note",
  image: "Picture",
  video: "Video",
  table: "Table",
  columns: "Columns",
  divider: "Line",
  bulletListItem: "List",
  numberedListItem: "List",
  codeBlock: "Code",
  file: "File",
  embed: "Embed",
  bookmark: "Link preview",
  toggle: "Toggle",
};
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The plain name of a block in the outline. Screens never say "part" or "pattern" (spec 05, 17.2). */
export function blockLabel(block: LayoutBlock): string {
  const props = block.props;
  if (block.type === "part") {
    const name = typeof props["name"] === "string" ? props["name"] : "";
    return name === "header" ? "Header" : name === "footer" ? "Footer" : `Shared part: ${name}`;
  }
  if (block.type === "menu") {
    const place = typeof props["place"] === "string" ? props["place"] : "primary";
    return place === "primary"
      ? "Menu: main"
      : place === "footer"
        ? "Menu: footer"
        : `Menu: ${place}`;
  }
  if (block.type === "section") {
    const tag = typeof props["tag"] === "string" ? props["tag"] : "div";
    const name = typeof props["name"] === "string" && props["name"] ? ` "${props["name"]}"` : "";
    const kind =
      {
        header: "Top area",
        footer: "Bottom area",
        main: "Main area",
        aside: "Side area",
        nav: "Navigation area",
      }[tag] ?? "Group";
    return `${kind}${name}`;
  }
  if (SITE_NAMES[block.type]) return SITE_NAMES[block.type]!;
  const words = firstWords(block.content);
  const name = CONTENT_NAMES[block.type] ?? capital(block.type);
  return words ? `${name}: ${words}` : name;
}

/** True for blocks whose text the owner edits in the text editor (everything that is not a site block). */
export const isContentBlock = (block: LayoutBlock) =>
  !(block.type in SITE_NAMES) && !["part", "menu", "section"].includes(block.type);

/** The plain name of a layout (spec 05, 17.2). */
export function layoutTitle(key: string, themeTitle: string): string {
  const [folder, name = ""] = key.split("/");
  if (folder === "parts")
    return name === "header" ? "Header" : name === "footer" ? "Footer" : themeTitle;
  const fixed: Record<string, string> = {
    "front-page": "Home",
    index: "Default (used when no other layout fits)",
    home: "Blog list",
    "single-post": "Blog post",
    single: "Single entry",
    page: "Page",
    archive: "Category and tag pages",
    category: "Category pages",
    tag: "Tag pages",
    search: "Search results",
    "404": "Not found",
  };
  if (fixed[name]) return fixed[name]!;
  if (name.startsWith("page-")) return `Page: ${name.slice(5)}`;
  if (name.startsWith("single-post-")) return `Blog post: ${name.slice(12)}`;
  if (name.startsWith("single-")) return `${capital(name.slice(7))} (one entry)`;
  return themeTitle || name;
}
