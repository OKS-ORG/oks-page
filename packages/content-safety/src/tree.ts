// The block tree of the layout editor (spec 06, section 3): where a block may go, moving, duplicating, the limits, and
// the plain sentences for a refusal. Every operation works on a copy and returns either the new tree or a refusal, so a
// failed operation leaves the tree exactly as it was. Every operation also returns its exact inverse (for undo, PB-25).
import { MAX_BLOCKS, MAX_CHILDREN_DEPTH, type Block } from "./blocks.js";

export type TreeResult =
  { ok: true; tree: Block[]; inverse: TreeOp } | { ok: false; message: string };

/** One change to the tree, written so it can be applied again or reversed. */
export type TreeOp =
  | { kind: "insert"; parentId: string | null; index: number; block: Block }
  | { kind: "remove"; id: string }
  | { kind: "move"; id: string; parentId: string | null; index: number }
  | { kind: "props"; id: string; props: Record<string, unknown>; content?: unknown };

const NAMES: Record<string, string> = {
  section: "section",
  container: "container",
  columns: "columns block",
  column: "column",
  spacer: "spacer",
  button: "button",
  buttonGroup: "button group",
  gallery: "gallery",
  audio: "audio player",
  icon: "icon",
  map: "map",
  socialLinks: "social links block",
  accordion: "accordion",
  toggle: "accordion item",
  tabs: "tabs block",
  tab: "tab",
  slider: "slider",
  slide: "slide",
};
const nameOf = (type: string): string => NAMES[type] ?? type;
const article = (name: string): string => (/^[aeiou]/i.test(name) ? "an" : "a");

/** Blocks that hold only buttons or text and never have children of their own in the layout editor. */
const LEAVES = new Set([
  "spacer",
  "divider",
  "image",
  "icon",
  "button",
  "gallery",
  "audio",
  "map",
  "socialLinks",
]);

/** Blocks that hold one kind of child and nothing else (the plain sentence says which). */
const ONLY_CHILD: Record<string, string> = {
  columns: "column",
  buttonGroup: "button",
  tabs: "tab",
  slider: "slide",
  accordion: "toggle",
};
/** Blocks that only make sense inside one kind of parent. */
const ONLY_IN: Record<string, string> = { column: "columns", tab: "tabs", slide: "slider" };

/** Whether `child` may go inside `parent` (`null` is the top of the page). Returns a plain sentence, or null if fine. */
export function placementProblem(parent: string | null, child: string): string | null {
  if (parent === "columns" && child !== "column")
    return `A ${nameOf(child)} cannot go straight inside columns. Put it inside a column.`;
  const home = ONLY_IN[child];
  if (home && parent !== home)
    return `${cap(article(nameOf(child)))} ${nameOf(child)} can only go inside ${article(nameOf(home))} ${nameOf(home)}.`;
  if (child === "section" && parent !== null)
    return `A section can only be at the top of the page, not inside ${article(nameOf(parent))} ${nameOf(parent)}.`;
  const only = parent ? ONLY_CHILD[parent] : undefined;
  if (parent && only && child !== only)
    return `${cap(article(nameOf(parent)))} ${nameOf(parent)} holds only ${nameOf(only)}s, not ${article(nameOf(child))} ${nameOf(child)}.`;
  if (parent !== null && LEAVES.has(parent))
    return `${cap(article(nameOf(parent)))} ${nameOf(parent)} cannot hold other blocks.`;
  return null;
}

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const cloneTree = (tree: Block[]): Block[] => structuredClone(tree);

interface Found {
  block: Block;
  list: Block[];
  index: number;
  parent: Block | null;
  depth: number;
}

function find(tree: Block[], id: string): Found | null {
  const walk = (list: Block[], parent: Block | null, depth: number): Found | null => {
    for (let i = 0; i < list.length; i++) {
      const block = list[i]!;
      if (block.id === id) return { block, list, index: i, parent, depth };
      const inside = walk(block.children, block, depth + 1);
      if (inside) return inside;
    }
    return null;
  };
  return walk(tree, null, 1);
}

export const countBlocks = (tree: Block[]): number =>
  tree.reduce((sum, b) => sum + 1 + countBlocks(b.children), 0);

/** How many levels a block and everything inside it takes. */
const height = (block: Block): number =>
  1 + block.children.reduce((most, c) => Math.max(most, height(c)), 0);

function containsId(block: Block, id: string): boolean {
  return block.id === id || block.children.some((c) => containsId(c, id));
}

/** A copy of a block with new, unique ids all the way down. Settings are kept. */
export function duplicateBlock(block: Block): Block {
  const copy = structuredClone(block);
  const fresh = (b: Block): void => {
    b.id = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 26);
    b.children.forEach(fresh);
  };
  fresh(copy);
  return copy;
}

function checkNew(tree: Block[], parent: Found | null, block: Block): string | null {
  const bad = placementProblem(parent?.block.type ?? null, block.type);
  if (bad) return bad;
  const depth = (parent?.depth ?? 0) + height(block);
  if (depth > MAX_CHILDREN_DEPTH)
    return `This would nest blocks more than ${MAX_CHILDREN_DEPTH} levels deep. Move it somewhere higher up.`;
  if (countBlocks(tree) + countBlocks([block]) > MAX_BLOCKS)
    return `A page can have at most ${MAX_BLOCKS.toLocaleString("en")} blocks.`;
  return null;
}

function listOf(
  tree: Block[],
  parentId: string | null,
): { list: Block[]; at: Found | null } | null {
  if (parentId === null) return { list: tree, at: null };
  const at = find(tree, parentId);
  return at ? { list: at.block.children, at } : null;
}

export function insertBlock(
  source: Block[],
  parentId: string | null,
  index: number,
  block: Block,
): TreeResult {
  const tree = cloneTree(source);
  const target = listOf(tree, parentId);
  if (!target) return { ok: false, message: "That place is no longer on the page." };
  if (find(tree, block.id)) return { ok: false, message: "That block is already on the page." };
  const bad = checkNew(tree, target.at, block);
  if (bad) return { ok: false, message: bad };
  const at = Math.min(Math.max(Math.trunc(index) || 0, 0), target.list.length);
  target.list.splice(at, 0, structuredClone(block));
  return { ok: true, tree, inverse: { kind: "remove", id: block.id } };
}

export function removeBlock(source: Block[], id: string): TreeResult {
  const tree = cloneTree(source);
  const found = find(tree, id);
  if (!found) return { ok: false, message: "That block is no longer on the page." };
  found.list.splice(found.index, 1);
  return {
    ok: true,
    tree,
    inverse: {
      kind: "insert",
      parentId: found.parent?.id ?? null,
      index: found.index,
      block: found.block,
    },
  };
}

export function moveBlock(
  source: Block[],
  id: string,
  parentId: string | null,
  index: number,
): TreeResult {
  const tree = cloneTree(source);
  const found = find(tree, id);
  if (!found) return { ok: false, message: "That block is no longer on the page." };
  if (parentId !== null && containsId(found.block, parentId))
    return { ok: false, message: "A block cannot be moved into itself." };
  const from = { parentId: found.parent?.id ?? null, index: found.index };
  found.list.splice(found.index, 1);
  const target = listOf(tree, parentId);
  if (!target) return { ok: false, message: "That place is no longer on the page." };
  // The depth rule is checked against the tree without the moving block, so a move never counts the block twice.
  const bad = checkNew(tree, target.at, found.block);
  if (bad) return { ok: false, message: bad };
  const at = Math.min(Math.max(Math.trunc(index) || 0, 0), target.list.length);
  target.list.splice(at, 0, found.block);
  return {
    ok: true,
    tree,
    inverse: { kind: "move", id, parentId: from.parentId, index: from.index },
  };
}

/** Puts a copy of a block right after the original, with new ids. */
export function duplicateInPlace(source: Block[], id: string): TreeResult {
  const found = find(source, id);
  if (!found) return { ok: false, message: "That block is no longer on the page." };
  return insertBlock(
    source,
    found.parent?.id ?? null,
    found.index + 1,
    duplicateBlock(found.block),
  );
}

/** Replaces one block's settings. The inverse puts the old settings back, including ones that did not exist before. */
export function updateProps(
  source: Block[],
  id: string,
  props: Record<string, unknown>,
  content?: unknown,
): TreeResult {
  const tree = cloneTree(source);
  const found = find(tree, id);
  if (!found) return { ok: false, message: "That block is no longer on the page." };
  const before = found.block.props;
  const textBefore = found.block.content;
  found.block.props = structuredClone(props);
  if (content !== undefined) found.block.content = structuredClone(content);
  return {
    ok: true,
    tree,
    inverse: {
      kind: "props",
      id,
      props: before,
      ...(content !== undefined ? { content: textBefore } : {}),
    },
  };
}

export function applyOp(tree: Block[], op: TreeOp): TreeResult {
  switch (op.kind) {
    case "insert":
      return insertBlock(tree, op.parentId, op.index, op.block);
    case "remove":
      return removeBlock(tree, op.id);
    case "move":
      return moveBlock(tree, op.id, op.parentId, op.index);
    case "props":
      return updateProps(tree, op.id, op.props, op.content);
  }
}
