// The save rule (spec 01, section 6; spec 07, section 7; DM-32 and DM-22).
//
// A save names the `revision` it started from. The database accepts it only if that is still the current one
// (`update ... where id = ? and revision = ?`), so of many saves from the same old revision exactly one wins.
// The same transaction rewrites `entry_media` (which files the entry uses), so a failed save leaves nothing behind.
import type { SqlRunner } from "../runner.js";

/** Columns a save may change. A whitelist: names are written into the SQL. */
const JSON_COLUMNS = ["fields", "body", "seo", "meta"] as const;
const PLAIN_COLUMNS = [
  "title",
  "slug",
  "status",
  "parent_id",
  "locale",
  "plain_text",
  "html",
] as const;
const TIME_COLUMNS = ["published_at", "scheduled_at", "trashed_at"] as const;

export type EntryChanges = Partial<
  Record<(typeof PLAIN_COLUMNS)[number], string | null> &
    Record<(typeof JSON_COLUMNS)[number], unknown> &
    Record<(typeof TIME_COLUMNS)[number], Date | null>
>;

export interface SaveEntryInput {
  entryId: string;
  /** The revision the editor loaded. */
  fromRevision: number;
  changes: EntryChanges;
  /** The files the saved entry uses, as (media id, field). Replaces the earlier list when given. */
  media?: { mediaId: string; field: string }[];
  now?: Date;
}

export type SaveEntryResult =
  | { ok: true; revision: number }
  | { ok: false; reason: "conflict"; currentRevision: number }
  | { ok: false; reason: "not_found" };

export async function saveEntry(db: SqlRunner, input: SaveEntryInput): Promise<SaveEntryResult> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(input.changes)) {
    if ((PLAIN_COLUMNS as readonly string[]).includes(key)) {
      sets.push(`"${key}" = ?`);
      params.push(value);
    } else if ((JSON_COLUMNS as readonly string[]).includes(key)) {
      sets.push(`"${key}" = ?`);
      params.push(JSON.stringify(value));
    } else if ((TIME_COLUMNS as readonly string[]).includes(key)) {
      sets.push(`"${key}" = ?`);
      params.push(value);
    } else {
      throw new Error(`"${key}" is not a column a save may change`);
    }
  }
  sets.push(`"revision" = "revision" + 1`, `"updated_at" = ?`);
  params.push(input.now ?? new Date());

  return db.transaction(async (tx) => {
    const updated = await tx.all(
      `update "entries" set ${sets.join(", ")} where "id" = ? and "revision" = ? returning "revision"`,
      [...params, input.entryId, input.fromRevision],
    );
    if (updated.length === 0) {
      const current = await tx.all(`select "revision" from "entries" where "id" = ?`, [
        input.entryId,
      ]);
      if (current.length === 0) return { ok: false, reason: "not_found" } as const;
      return {
        ok: false,
        reason: "conflict",
        currentRevision: Number(current[0]!["revision"]),
      } as const;
    }
    if (input.media) {
      await tx.all(`delete from "entry_media" where "entry_id" = ?`, [input.entryId]);
      for (const m of input.media)
        await tx.all(
          `insert into "entry_media" ("entry_id", "media_id", "field") values (?, ?, ?)`,
          [input.entryId, m.mediaId, m.field],
        );
    }
    return { ok: true, revision: Number(updated[0]!["revision"]) } as const;
  });
}
