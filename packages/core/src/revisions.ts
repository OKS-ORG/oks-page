// Revisions (spec 03, "Revisions"): every save keeps a full copy. An author sees who saved when and what changed,
// compares an older copy with the page as it is now, and restores one with a single step. A restore is itself a save,
// so it goes through the same checks and can be undone the same way.
import type { Block } from "@oks-page/content-safety";
import type { SqlRunner } from "@oks-page/db";
import { writeBlocks } from "@oks-page/renderer";
import { saveContent, type Actor, type ContentResult, type SavedContent } from "./content.js";
import { diffLines, type DiffLine, type Snapshot } from "./revision-parts.js";

const fail = (
  code: "forbidden" | "not_found",
  message: string,
): { ok: false; code: typeof code; message: string } => ({ ok: false, code, message });

const parseJson = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(Number(value)));

async function entryFor(runner: SqlRunner, actor: Actor, siteId: string, id: string) {
  const row = (
    await runner.all(
      `select "type_key", "author_id", "title", "slug", "status", "revision", "body", "scheduled_at" from "entries" where "id" = ? and "site_id" = ? and "status" <> 'trash'`,
      [id, siteId],
    )
  )[0];
  if (!row) return fail("not_found", "This entry does not exist.");
  const type = String(row["type_key"]);
  const authorId = String(row["author_id"]);
  const allowed =
    actor.can("content.edit_any", type) ||
    (actor.can("content.edit_own", type) && authorId === actor.userId);
  if (!allowed) return fail("forbidden", "You may not see the revisions of this.");
  return { ok: true as const, row };
}

export interface ListedRevision {
  id: string;
  summary: string;
  authorName: string;
  createdAt: string;
}

/** The saved copies of an entry, newest first. */
export async function listRevisions(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  entryId: string,
  limit = 60,
): Promise<ContentResult<{ revisions: ListedRevision[] }>> {
  const found = await entryFor(runner, actor, siteId, entryId);
  if (!found.ok) return found;
  const rows = await runner.all(
    `select r."id", r."summary", r."created_at", u."name" as author_name
       from "entry_revisions" r left join "users" u on u."id" = r."author_id"
      where r."entry_id" = ? and r."kind" = 'revision'
      order by r."created_at" desc, r."id" desc limit ${Math.min(Math.max(Math.trunc(limit), 1), 200)}`,
    [entryId],
  );
  return {
    ok: true,
    revisions: rows.map((r) => ({
      id: String(r["id"]),
      summary: String(r["summary"]),
      authorName: String(r["author_name"] ?? ""),
      createdAt: toDate(r["created_at"]).toISOString(),
    })),
  };
}

const textOf = (blocks: unknown): string => {
  const list = Array.isArray(blocks) ? (blocks as Block[]) : [];
  return writeBlocks(list).plainText;
};

async function snapshotOf(runner: SqlRunner, entryId: string, revisionId: string) {
  const row = (
    await runner.all(
      `select "snapshot", "created_at" from "entry_revisions" where "id" = ? and "entry_id" = ? and "kind" = 'revision'`,
      [revisionId, entryId],
    )
  )[0];
  if (!row) return null;
  return { snapshot: parseJson(row["snapshot"]) as Snapshot, createdAt: toDate(row["created_at"]) };
}

export interface RevisionCompare {
  createdAt: string;
  /** The title in that copy and now. */
  title: { before: string; now: string };
  /** The text of that copy against the text now: what was removed since, and what was added. */
  lines: DiffLine[];
}

/** An older copy against the entry as it is now. */
export async function compareRevision(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  entryId: string,
  revisionId: string,
): Promise<ContentResult<{ compare: RevisionCompare }>> {
  const found = await entryFor(runner, actor, siteId, entryId);
  if (!found.ok) return found;
  const old = await snapshotOf(runner, entryId, revisionId);
  if (!old) return fail("not_found", "This copy does not exist.");
  const body = parseJson(found.row["body"]) as { blocks?: unknown[] } | unknown[] | null;
  const nowBlocks = Array.isArray(body) ? body : (body?.blocks ?? []);
  return {
    ok: true,
    compare: {
      createdAt: old.createdAt.toISOString(),
      title: { before: old.snapshot.title, now: String(found.row["title"]) },
      lines: diffLines(textOf(old.snapshot.body?.blocks), textOf(nowBlocks)),
    },
  };
}

/**
 * Puts an older copy's title and content back as a new save. The address and the status stay as they are now, so a
 * restore never publishes or unpublishes anything by itself.
 */
export async function restoreRevision(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  entryId: string,
  revisionId: string,
  fromRevision: number,
  now: () => number = Date.now,
): Promise<ContentResult<SavedContent>> {
  const found = await entryFor(runner, actor, siteId, entryId);
  if (!found.ok) return found;
  const old = await snapshotOf(runner, entryId, revisionId);
  if (!old) return fail("not_found", "This copy does not exist.");
  const slug = String(found.row["slug"]);
  return saveContent(
    runner,
    actor,
    siteId,
    entryId,
    {
      title: old.snapshot.title,
      slugPart: slug.slice(slug.lastIndexOf("/") + 1),
      status: String(found.row["status"]),
      scheduledAt:
        found.row["scheduled_at"] == null ? null : toDate(found.row["scheduled_at"]).toISOString(),
      blocks: old.snapshot.body?.blocks ?? [],
      revision: fromRevision,
    },
    now,
    {
      summary: `Restored the copy from ${old.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    },
  );
}
