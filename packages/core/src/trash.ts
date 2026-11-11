// The trash (spec 03, section 6; spec 01): an entry is moved to the trash first, can be restored as a draft, and is
// deleted for good by hand or by itself after 30 days. Nothing here changes an entry's text.
import type { SqlRunner } from "@oks-page/db";
import type { Actor, ContentResult } from "./content.js";

export const TRASH_DAYS = 30;

const fail = (
  code: "forbidden" | "not_found",
  message: string,
): { ok: false; code: typeof code; message: string } => ({ ok: false, code, message });

const mayDelete = (actor: Actor, type: string, authorId: string): boolean =>
  actor.can("content.delete_any", type) ||
  (actor.can("content.delete_own", type) && authorId === actor.userId);

async function load(runner: SqlRunner, siteId: string, id: string) {
  const row = (
    await runner.all(
      `select "type_key", "author_id", "status", "slug", "title" from "entries" where "id" = ? and "site_id" = ?`,
      [id, siteId],
    )
  )[0];
  return row
    ? {
        type: String(row["type_key"]),
        authorId: String(row["author_id"]),
        status: String(row["status"]),
        slug: String(row["slug"]),
        title: String(row["title"]),
      }
    : null;
}

/** Moves an entry to the trash. It leaves the site at once; a published page is gone from the public address. */
export async function trashEntry(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  now: () => number = Date.now,
): Promise<ContentResult<{ type: string; wasPublished: boolean }>> {
  const row = await load(runner, siteId, id);
  if (!row || row.status === "trash") return fail("not_found", "This entry does not exist.");
  if (!mayDelete(actor, row.type, row.authorId))
    return fail("forbidden", "You may not delete this.");
  const at = new Date(now());
  await runner.all(
    `update "entries" set "status" = 'trash', "trashed_at" = ?, "revision" = "revision" + 1, "updated_at" = ? where "id" = ?`,
    [at, at, id],
  );
  return { ok: true, type: row.type, wasPublished: row.status === "published" };
}

/** Brings an entry back as a draft. If its address was taken in the meantime, it gets -2, -3 and so on. */
export async function restoreEntry(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  now: () => number = Date.now,
): Promise<ContentResult<{ type: string; slug: string }>> {
  const row = await load(runner, siteId, id);
  if (!row || row.status !== "trash") return fail("not_found", "This is not in the trash.");
  if (!mayDelete(actor, row.type, row.authorId))
    return fail("forbidden", "You may not restore this.");
  let slug = row.slug;
  for (let n = 2; ; n++) {
    const clash = (
      await runner.all(
        `select "id" from "entries" where "site_id" = ? and "type_key" = ? and "locale" = '' and "slug" = ? and "status" <> 'trash'`,
        [siteId, row.type, slug],
      )
    )[0];
    if (!clash) break;
    slug = `${row.slug}-${n}`;
  }
  const at = new Date(now());
  await runner.all(
    `update "entries" set "status" = 'draft', "trashed_at" = null, "slug" = ?, "revision" = "revision" + 1, "updated_at" = ? where "id" = ?`,
    [slug, at, id],
  );
  return { ok: true, type: row.type, slug };
}

/** Deletes an entry for good, with its revisions. It has to be in the trash first. */
export async function deleteForever(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<ContentResult<{ type: string }>> {
  const row = await load(runner, siteId, id);
  if (!row || row.status !== "trash") return fail("not_found", "This is not in the trash.");
  if (!mayDelete(actor, row.type, row.authorId))
    return fail("forbidden", "You may not delete this.");
  await runner.all(`delete from "entries" where "id" = ?`, [id]);
  return { ok: true, type: row.type };
}

export interface TrashedEntry {
  id: string;
  title: string;
  slug: string;
  trashedAt: string;
  /** Whole days left before it is deleted by itself. */
  daysLeft: number;
}

/** What is in the trash for one type. Someone who may only delete their own sees only theirs. */
export async function listTrash(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  type: string,
  now: () => number = Date.now,
): Promise<TrashedEntry[]> {
  const everyone = actor.can("content.delete_any", type);
  if (!everyone && !actor.can("content.delete_own", type)) return [];
  const rows = await runner.all(
    `select "id", "title", "slug", "trashed_at" from "entries"
      where "site_id" = ? and "type_key" = ? and "status" = 'trash' ${everyone ? "" : 'and "author_id" = ?'}
      order by "trashed_at" desc, "id" limit 500`,
    everyone ? [siteId, type] : [siteId, type, actor.userId],
  );
  return rows.map((r) => {
    const at =
      r["trashed_at"] instanceof Date ? r["trashed_at"] : new Date(Number(r["trashed_at"]));
    const left = Math.ceil((at.getTime() + TRASH_DAYS * 86_400_000 - now()) / 86_400_000);
    return {
      id: String(r["id"]),
      title: String(r["title"]),
      slug: String(r["slug"]),
      trashedAt: at.toISOString(),
      daysLeft: Math.max(left, 0),
    };
  });
}

/** Deletes what has been in the trash for more than 30 days. Returns how many entries went. */
export async function purgeTrash(runner: SqlRunner, now: () => number = Date.now): Promise<number> {
  const before = new Date(now() - TRASH_DAYS * 86_400_000);
  const gone = await runner.all(
    `delete from "entries" where "status" = 'trash' and "trashed_at" < ? returning "id"`,
    [before],
  );
  return gone.length;
}
