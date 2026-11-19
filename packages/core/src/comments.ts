// Comments on posts (spec 04, comments). A visitor leaves a name and a text; the comment waits until someone who may
// moderate approves it. Nothing is stored that identifies the visitor (no email, no address). Comments are off until
// a person who manages the settings turns them on. A comment is plain text: it is shown with its line breaks and never as HTML.
import type { SqlRunner } from "@oks-page/db";
import { newId } from "@oks-page/db";
import type { Actor } from "./content.js";

export const COMMENTS_KEY = "comments";
export const COMMENT_STATUSES = ["pending", "approved", "spam", "trash"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const MAX_COMMENT_LENGTH = 2000;
const MAX_LINKS = 2;

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

type Fail = {
  ok: false;
  code: "forbidden" | "invalid" | "not_found" | "closed";
  message: string;
  field?: string;
};
const fail = (code: Fail["code"], message: string, field?: string): Fail => ({
  ok: false,
  code,
  message,
  ...(field ? { field } : {}),
});

/** True when visitors may comment on posts. Off for a new site. */
export async function commentsEnabled(runner: SqlRunner, siteId: string): Promise<boolean> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, COMMENTS_KEY],
  );
  const value = decode(runner, rows[0]?.["value"]) as { enabled?: unknown } | null;
  return value?.enabled === true;
}

export async function saveCommentsEnabled(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  enabled: unknown,
): Promise<{ ok: true; enabled: boolean } | Fail> {
  if (!actor.can("settings.manage"))
    return fail("forbidden", "You may not change the site settings.");
  if (typeof enabled !== "boolean") return fail("invalid", "Choose on or off.", "enabled");
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, COMMENTS_KEY, JSON.stringify({ enabled }), new Date()],
  );
  return { ok: true, enabled };
}

/** What a visitor sent, checked: a name, a text, not too many links. Returns the cleaned values or a plain message. */
export function checkCommentInput(input: {
  name?: unknown;
  content?: unknown;
}): { ok: true; name: string; content: string } | Fail {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const content =
    typeof input.content === "string" ? input.content.replace(/\r\n?/g, "\n").trim() : "";
  if (!name) return fail("invalid", "Give your name.", "name");
  if (name.length > 80) return fail("invalid", "The name can be at most 80 characters.", "name");
  if (!content) return fail("invalid", "Write your comment.", "content");
  if (content.length > MAX_COMMENT_LENGTH)
    return fail(
      "invalid",
      `The comment can be at most ${MAX_COMMENT_LENGTH} characters.`,
      "content",
    );
  const links = content.match(/https?:\/\/|www\./gi)?.length ?? 0;
  if (links > MAX_LINKS)
    return fail("invalid", `A comment can have at most ${MAX_LINKS} links.`, "content");
  return { ok: true, name, content };
}

/** A visitor's comment on a published post. It starts as "pending". */
export async function addComment(
  runner: SqlRunner,
  siteId: string,
  input: { entryId: string; name?: unknown; content?: unknown },
  now: () => number = Date.now,
): Promise<{ ok: true; id: string } | Fail> {
  if (!(await commentsEnabled(runner, siteId)))
    return fail("closed", "Comments are turned off on this site.");
  const entry = (
    await runner.all(
      `select "id" from "entries" where "id" = ? and "site_id" = ? and "type_key" = 'post' and "status" = 'published'`,
      [input.entryId, siteId],
    )
  )[0];
  if (!entry) return fail("not_found", "You can only comment on a published post.");
  const checked = checkCommentInput(input);
  if (!checked.ok) return checked;
  const id = newId();
  await runner.all(
    `insert into "comments" ("id", "site_id", "entry_id", "author_name", "content", "status", "created_at") values (?, ?, ?, ?, ?, 'pending', ?)`,
    [id, siteId, input.entryId, checked.name, checked.content, new Date(now())],
  );
  return { ok: true, id };
}

export interface PublicComment {
  id: string;
  name: string;
  content: string;
  createdAt: string;
}

const toIso = (value: unknown): string =>
  (value instanceof Date ? value : new Date(Number(value))).toISOString();

/** The approved comments of a post, oldest first, for the public page. Empty while comments are off. */
export async function approvedComments(
  runner: SqlRunner,
  siteId: string,
  entryId: string,
): Promise<{ enabled: boolean; comments: PublicComment[] }> {
  if (!(await commentsEnabled(runner, siteId))) return { enabled: false, comments: [] };
  const rows = await runner.all(
    `select "id", "author_name", "content", "created_at" from "comments"
      where "site_id" = ? and "entry_id" = ? and "status" = 'approved' order by "created_at", "id" limit 500`,
    [siteId, entryId],
  );
  return {
    enabled: true,
    comments: rows.map((r) => ({
      id: String(r["id"]),
      name: String(r["author_name"]),
      content: String(r["content"]),
      createdAt: toIso(r["created_at"]),
    })),
  };
}

export interface ListedComment extends PublicComment {
  status: CommentStatus;
  entryId: string;
  entryTitle: string;
  entrySlug: string;
}

/** The comments with one status, newest first, for the moderation screen. */
export async function listComments(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  status: string,
): Promise<{ ok: true; comments: ListedComment[]; counts: Record<CommentStatus, number> } | Fail> {
  if (!actor.can("comments.moderate")) return fail("forbidden", "You may not moderate comments.");
  const wanted = (COMMENT_STATUSES as readonly string[]).includes(status) ? status : "pending";
  const rows = await runner.all(
    `select c."id", c."author_name", c."content", c."created_at", c."status", c."entry_id", e."title", e."slug"
       from "comments" c join "entries" e on e."id" = c."entry_id"
      where c."site_id" = ? and c."status" = ? order by c."created_at" desc, c."id" limit 200`,
    [siteId, wanted],
  );
  const counts: Record<CommentStatus, number> = { pending: 0, approved: 0, spam: 0, trash: 0 };
  for (const r of await runner.all(
    `select "status", count(*) as n from "comments" where "site_id" = ? group by "status"`,
    [siteId],
  ))
    counts[String(r["status"]) as CommentStatus] = Number(r["n"]);
  return {
    ok: true,
    counts,
    comments: rows.map((r) => ({
      id: String(r["id"]),
      name: String(r["author_name"]),
      content: String(r["content"]),
      createdAt: toIso(r["created_at"]),
      status: String(r["status"]) as CommentStatus,
      entryId: String(r["entry_id"]),
      entryTitle: String(r["title"]),
      entrySlug: String(r["slug"]),
    })),
  };
}

export const COMMENT_ACTIONS = ["approve", "spam", "trash", "restore", "delete"] as const;
export type CommentAction = (typeof COMMENT_ACTIONS)[number];

/** Approve, mark as spam, move to the trash, bring back (to "waiting"), or delete for good (from the trash only). */
export async function moderateComment(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  action: unknown,
): Promise<{ ok: true; entryId: string; entrySlug: string } | Fail> {
  if (!actor.can("comments.moderate")) return fail("forbidden", "You may not moderate comments.");
  if (typeof action !== "string" || !(COMMENT_ACTIONS as readonly string[]).includes(action))
    return fail("invalid", "This action is not known.");
  const row = (
    await runner.all(
      `select c."status", c."entry_id", e."slug" from "comments" c join "entries" e on e."id" = c."entry_id"
        where c."id" = ? and c."site_id" = ?`,
      [id, siteId],
    )
  )[0];
  if (!row) return fail("not_found", "This comment does not exist.");
  const entryId = String(row["entry_id"]);
  const entrySlug = String(row["slug"]);
  if (action === "delete") {
    if (String(row["status"]) !== "trash")
      return fail("invalid", "Move the comment to the trash first.");
    await runner.all(`delete from "comments" where "id" = ?`, [id]);
    return { ok: true, entryId, entrySlug };
  }
  const to = { approve: "approved", spam: "spam", trash: "trash", restore: "pending" }[action]!;
  await runner.all(`update "comments" set "status" = ? where "id" = ?`, [to, id]);
  return { ok: true, entryId, entrySlug };
}

/** The number of comments waiting for a decision (for the menu and the dashboard). */
export async function pendingCommentCount(runner: SqlRunner, siteId: string): Promise<number> {
  const rows = await runner.all(
    `select count(*) as n from "comments" where "site_id" = ? and "status" = 'pending'`,
    [siteId],
  );
  return Number(rows[0]?.["n"] ?? 0);
}
