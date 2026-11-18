// Locks (spec 06, section 5): `props.locked = true` fully locks a block and everything inside it; `lockMode: "content"`
// lets a client edit the text but not move or restyle. A designer can edit anything. A client cannot add or remove locks.
import type { Block } from "./blocks.js";

/** JSON with the keys in a fixed order, so two copies of the same value compare equal whatever order a database kept. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export const LOCKED_MESSAGE = "This part is locked by your designer.";

interface Entry {
  block: Block;
  parentId: string | null;
  /** How the nearest locked block above (or this one) locks: "full", "content", or null when nothing is locked. */
  lock: "full" | "content" | null;
}

function lockOf(block: Block, inherited: Entry["lock"]): Entry["lock"] {
  if (inherited === "full") return "full";
  if (block.props["locked"] === true)
    return block.props["lockMode"] === "content" ? (inherited ?? "content") : "full";
  return inherited;
}

function index(
  blocks: Block[],
  parentId: string | null,
  inherited: Entry["lock"],
  into: Map<string, Entry>,
): void {
  for (const block of blocks) {
    const lock = lockOf(block, inherited);
    into.set(block.id, { block, parentId, lock });
    index(block.children, block.id, lock, into);
  }
}

/** True when a person who is not a designer may not have made this change. Returns a plain sentence, or null. */
export function lockViolation(before: Block[], after: Block[]): string | null {
  const was = new Map<string, Entry>();
  const now = new Map<string, Entry>();
  index(before, null, null, was);
  index(after, null, null, now);
  for (const [id, entry] of now) {
    // A new block cannot arrive locked, and nobody else can add or remove a lock.
    const old = was.get(id);
    const locked = entry.block.props["locked"];
    const mode = entry.block.props["lockMode"];
    if (!old) {
      if (locked === true || mode !== undefined) return LOCKED_MESSAGE;
      // A new block cannot go into a locked part.
      const parent = entry.parentId ? was.get(entry.parentId) : null;
      if (parent && parent.lock !== null) return LOCKED_MESSAGE;
    } else if (old.block.props["locked"] !== locked || old.block.props["lockMode"] !== mode) {
      return LOCKED_MESSAGE;
    }
  }
  for (const [id, entry] of was) {
    if (entry.lock === null) continue;
    const kept = now.get(id);
    if (!kept) return LOCKED_MESSAGE; // a locked part cannot be removed
    if (kept.parentId !== entry.parentId) return LOCKED_MESSAGE; // or moved
    if (stable(kept.block.props) !== stable(entry.block.props)) return LOCKED_MESSAGE; // or restyled
    const childIds = (b: Block) => b.children.map((c) => c.id).join(",");
    if (childIds(kept.block) !== childIds(entry.block)) return LOCKED_MESSAGE;
    // Under a full lock the words are fixed too.
    if (entry.lock === "full" && stable(kept.block.content) !== stable(entry.block.content))
      return LOCKED_MESSAGE;
  }
  return null;
}

/** True when any block (at any depth) is locked. */
export const hasLock = (blocks: Block[]): boolean =>
  blocks.some((b) => b.props["locked"] === true || hasLock(b.children));
