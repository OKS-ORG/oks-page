// The small pieces revisions are made of (spec 03, "Revisions"): what a snapshot holds, a plain-words summary of what a
// save changed, a line-by-line compare, and the clean-up rule (all for 30 days, then the last 25 per entry).
import type { SqlRunner } from "@oks-page/db";

export const KEEP_ALL_DAYS = 30;
export const KEEP_LAST = 25;

/** A full copy of an entry as saved. */
export interface Snapshot {
  title: string;
  slug: string;
  status: string;
  body: { version: number; blocks: unknown[] };
}

export interface SavedState {
  title: string;
  slug: string;
  status: string;
  plainText: string;
  /** The body as JSON text, to notice changes that are not text (a picture, a setting). */
  bodyJson: string;
}

/** JSON text with the keys of every object in sorted order, so two equal bodies give the same text on any database. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(value)) ?? "null";
}

/** What a save changed, in words an author understands. */
export function summarise(before: SavedState | null, after: SavedState): string {
  if (!before) return "First save";
  const parts: string[] = [];
  if (before.title !== after.title) parts.push("changed the title");
  if (before.slug !== after.slug) parts.push("changed the address");
  if (before.status !== after.status)
    parts.push(after.status === "published" ? "published it" : "made it a draft");
  if (before.plainText !== after.plainText) parts.push("changed the text");
  else if (before.bodyJson !== after.bodyJson) parts.push("changed pictures or layout");
  if (parts.length === 0) return "Saved with no changes";
  const text = parts.join(", ");
  return text[0]!.toUpperCase() + text.slice(1);
}

export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

const MAX_LINES = 1500;

/** A line-by-line compare of two texts (the longest common run of lines). Very long texts are compared coarsely. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const out: DiffLine[] = [];
    for (const text of a) out.push({ kind: "removed", text });
    for (const text of b) out.push({ kind: "added", text });
    return out;
  }
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ kind: "removed", text: a[i++]! });
    else out.push({ kind: "added", text: b[j++]! });
  }
  while (i < m) out.push({ kind: "removed", text: a[i++]! });
  while (j < n) out.push({ kind: "added", text: b[j++]! });
  return out;
}

/** Deletes the revisions that are older than 30 days and not among the entry's last 25. */
export async function pruneRevisions(
  runner: SqlRunner,
  entryId: string,
  now: number,
): Promise<void> {
  await runner.all(
    `delete from "entry_revisions"
      where "entry_id" = ? and "kind" = 'revision' and "created_at" < ?
        and "id" not in (select "id" from "entry_revisions" where "entry_id" = ? and "kind" = 'revision'
                          order by "created_at" desc, "id" desc limit ${KEEP_LAST})`,
    [entryId, new Date(now - KEEP_ALL_DAYS * 86_400_000), entryId],
  );
}
