// Autosave and the "someone else is editing" notice (spec 03, "Revisions" and EC-38).
//
// Autosave keeps the newest unsaved copy per person and entry, apart from the published page and from the saved
// copies: it never changes what visitors see and never shows up in the earlier-copies list. A real save replaces it.
// The editing notice is a short lease (90 s, renewed every 30 s by the open edit screen). It only informs: a second
// person can always open the page and save, and the save rule (revision numbers) still protects against a clash.
import { checkBlocks } from "@oks-page/content-safety";
import { newId, type SqlRunner } from "@oks-page/db";
import { loadForEdit, type Actor, type ContentResult } from "./content.js";
import { canonicalJson } from "./revision-parts.js";
import { loadScreenSizes } from "./screen-sizes.js";

export const LOCK_SECONDS = 90;

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(Number(value)));
const parseJson = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;

export interface AutosaveInput {
  title: string;
  slugPart?: string;
  blocks: unknown;
  /** The revision the editor loaded. */
  revision: number;
}

export interface AutosavedCopy {
  title: string;
  blocks: unknown[];
  savedAt: string;
  /** The revision the copy started from. When the page has moved on, the copy is older than the page. */
  revision: number;
}

/** Keeps this person's newest unsaved copy of an entry (one per person: the older one is replaced). */
export async function saveAutosave(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  entryId: string,
  input: AutosaveInput,
  now: () => number = Date.now,
): Promise<ContentResult<{ savedAt: string }>> {
  const loaded = await loadForEdit(runner, actor, siteId, entryId);
  if (!loaded.ok) return loaded;
  const title = String(input.title ?? "")
    .trim()
    .slice(0, 200);
  const checked = checkBlocks(
    { version: 1, blocks: input.blocks },
    { breakpoints: await loadScreenSizes(runner, siteId) },
  );
  const at = new Date(now());
  const snapshot = {
    title,
    slug: loaded.entry.prefix + String(input.slugPart ?? loaded.entry.slugPart),
    revision: Number(input.revision),
    body: checked.body,
  };
  await runner.transaction(async (tx) => {
    await tx.all(
      `delete from "entry_revisions" where "entry_id" = ? and "author_id" = ? and "kind" = 'autosave'`,
      [entryId, actor.userId],
    );
    await tx.all(
      `insert into "entry_revisions" ("id", "entry_id", "kind", "snapshot", "summary", "author_id", "created_at") values (?, ?, 'autosave', ?, '', ?, ?)`,
      [newId(), entryId, JSON.stringify(snapshot), actor.userId, at],
    );
  });
  return { ok: true, savedAt: at.toISOString() };
}

/**
 * This person's unsaved copy, but only when it holds something the page does not (a copy equal to the page is no
 * use to anyone, so it is not offered).
 */
export async function loadAutosave(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  entryId: string,
): Promise<ContentResult<{ autosave: AutosavedCopy | null }>> {
  const loaded = await loadForEdit(runner, actor, siteId, entryId);
  if (!loaded.ok) return loaded;
  const row = (
    await runner.all(
      `select "snapshot", "created_at" from "entry_revisions" where "entry_id" = ? and "author_id" = ? and "kind" = 'autosave'`,
      [entryId, actor.userId],
    )
  )[0];
  if (!row) return { ok: true, autosave: null };
  const snap = parseJson(row["snapshot"]) as {
    title: string;
    revision: number;
    body: { blocks?: unknown[] };
  };
  const blocks = snap.body?.blocks ?? [];
  const same =
    snap.title === loaded.entry.title &&
    canonicalJson({ blocks }) === canonicalJson({ blocks: loaded.entry.blocks });
  if (same) return { ok: true, autosave: null };
  return {
    ok: true,
    autosave: {
      title: snap.title,
      blocks,
      savedAt: toDate(row["created_at"]).toISOString(),
      revision: Number(snap.revision),
    },
  };
}

/** Throws this person's unsaved copy away. */
export async function discardAutosave(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  entryId: string,
): Promise<ContentResult<Record<never, never>>> {
  const loaded = await loadForEdit(runner, actor, siteId, entryId);
  if (!loaded.ok) return loaded;
  await runner.all(
    `delete from "entry_revisions" where "entry_id" = ? and "author_id" = ? and "kind" = 'autosave'`,
    [entryId, actor.userId],
  );
  return { ok: true };
}

/** A real save makes this person's unsaved copy pointless. */
export async function clearAutosave(
  runner: SqlRunner,
  entryId: string,
  userId: string,
): Promise<void> {
  await runner.all(
    `delete from "entry_revisions" where "entry_id" = ? and "author_id" = ? and "kind" = 'autosave'`,
    [entryId, userId],
  );
}

/**
 * Renews this person's notice that they are editing the entry, and tells who else is (the name), if anyone. It never
 * blocks: when someone else holds a live notice, theirs stays and we only report it.
 */
export async function touchEditing(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  entryId: string,
  now: () => number = Date.now,
): Promise<ContentResult<{ otherEditor: string | null }>> {
  const loaded = await loadForEdit(runner, actor, siteId, entryId);
  if (!loaded.ok) return loaded;
  const at = new Date(now());
  const until = new Date(now() + LOCK_SECONDS * 1000);
  await runner.all(
    `insert into "entry_locks" ("entry_id", "user_id", "expires_at") values (?, ?, ?)
     on conflict ("entry_id") do update set "user_id" = excluded."user_id", "expires_at" = excluded."expires_at"
     where "entry_locks"."user_id" = excluded."user_id" or "entry_locks"."expires_at" <= ?`,
    [entryId, actor.userId, until, at],
  );
  const row = (
    await runner.all(
      `select l."user_id", l."expires_at", u."name" from "entry_locks" l left join "users" u on u."id" = l."user_id" where l."entry_id" = ?`,
      [entryId],
    )
  )[0];
  if (!row || String(row["user_id"]) === actor.userId) return { ok: true, otherEditor: null };
  return { ok: true, otherEditor: String(row["name"] ?? "Someone") };
}

/** Says this person has left the edit screen (only their own notice goes). */
export async function stopEditing(runner: SqlRunner, actor: Actor, entryId: string): Promise<void> {
  await runner.all(`delete from "entry_locks" where "entry_id" = ? and "user_id" = ?`, [
    entryId,
    actor.userId,
  ]);
}

/** Removes notices that ran out (called now and then by the timer). */
export async function purgeEditingNotices(
  runner: SqlRunner,
  now: () => number = Date.now,
): Promise<void> {
  await runner.all(`delete from "entry_locks" where "expires_at" <= ?`, [new Date(now())]);
}
