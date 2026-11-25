// A client's change to a live page (spec 11, section 4; decision D60): the change goes live at once, the designer is told, and can put
// the earlier version back with one click. Three parts:
//   - before the client's save, the page as it is now is kept as a copy (a restore point), unless the last copy already is it;
//   - after the save, a line in the audit log (always) and an email to the people who change the design (when email works, and
//     at most once for a page in 30 minutes, so a client who edits all afternoon does not fill an inbox);
//   - a restore link: sealed with the site's secret, good for 14 days, opening a screen that shows what changed and has one
//     button. Opening the link changes nothing; the button does.
import type { SqlRunner } from "@oks-page/db";
import { newId } from "@oks-page/db";
import type { Actor } from "./content.js";
import { sendClientEditEmails } from "./emails.js";
import { compareRevision, restoreRevision, type RevisionCompare } from "./revisions.js";
import { canonicalJson } from "./revision-parts.js";
import type { SiteSecrets } from "./secret-box.js";

export const CLIENT_NOTICE_KEY = "client_edit_notice";
export const CLIENT_NOTICES_SENT_KEY = "client_edit_notices";
/** One notice for a page in this time, however often the client saves. */
export const NOTICE_EVERY_MS = 30 * 60 * 1000;
export const RESTORE_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;
const PLACE = "client-restore";

const parse = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

async function readSetting(runner: SqlRunner, siteId: string, key: string): Promise<unknown> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  return parse(runner, rows[0]?.["value"]);
}
async function writeSetting(
  runner: SqlRunner,
  siteId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date()],
  );
}

/** Whether the designers are emailed about a client's change to a live page. On unless it was turned off. */
export async function clientNoticeOn(runner: SqlRunner, siteId: string): Promise<boolean> {
  const v = (await readSetting(runner, siteId, CLIENT_NOTICE_KEY)) as { enabled?: unknown } | null;
  return v?.enabled !== false;
}

export async function saveClientNoticeOn(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  enabled: unknown,
): Promise<
  { ok: true; enabled: boolean } | { ok: false; code: "forbidden" | "invalid"; message: string }
> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (typeof enabled !== "boolean")
    return { ok: false, code: "invalid", message: "The request was not understood." };
  await writeSetting(runner, siteId, CLIENT_NOTICE_KEY, { enabled });
  return { ok: true, enabled };
}

/**
 * Keeps the live page as it is now as a copy to go back to, and returns that copy's id. When the newest copy already holds
 * exactly this title and content, that one is used. Null when the page does not exist.
 */
export async function ensureRestorePoint(
  runner: SqlRunner,
  siteId: string,
  entryId: string,
  now: () => number = Date.now,
): Promise<string | null> {
  const row = (
    await runner.all(
      `select "title", "slug", "status", "body", "author_id" from "entries" where "id" = ? and "site_id" = ? and "status" <> 'trash'`,
      [entryId, siteId],
    )
  )[0];
  if (!row) return null;
  const body = parse(runner, row["body"]);
  const last = (
    await runner.all(
      `select "id", "snapshot" from "entry_revisions" where "entry_id" = ? and "kind" = 'revision' order by "created_at" desc, "id" desc limit 1`,
      [entryId],
    )
  )[0];
  if (last) {
    const snap = parse(runner, last["snapshot"]) as { title?: unknown; body?: unknown } | null;
    if (
      snap &&
      snap.title === String(row["title"]) &&
      canonicalJson(snap.body) === canonicalJson(body)
    )
      return String(last["id"]);
  }
  const id = newId();
  await runner.all(
    `insert into "entry_revisions" ("id", "entry_id", "kind", "snapshot", "summary", "author_id", "created_at") values (?, ?, 'revision', ?, ?, ?, ?)`,
    [
      id,
      entryId,
      JSON.stringify({
        title: String(row["title"]),
        slug: String(row["slug"]),
        status: String(row["status"]),
        body,
      }),
      "The page before a client's change",
      String(row["author_id"]),
      new Date(now()),
    ],
  );
  return id;
}

/** Whether the page differs from a kept copy (its title or its content). */
async function changedSince(
  runner: SqlRunner,
  siteId: string,
  entryId: string,
  copyId: string,
): Promise<boolean> {
  const row = (
    await runner.all(`select "title", "body" from "entries" where "id" = ? and "site_id" = ?`, [
      entryId,
      siteId,
    ])
  )[0];
  const copy = (
    await runner.all(`select "snapshot" from "entry_revisions" where "id" = ? and "entry_id" = ?`, [
      copyId,
      entryId,
    ])
  )[0];
  if (!row || !copy) return true;
  const snap = parse(runner, copy["snapshot"]) as { title?: unknown; body?: unknown } | null;
  return !(
    snap &&
    snap.title === String(row["title"]) &&
    canonicalJson(snap.body) === canonicalJson(parse(runner, row["body"]))
  );
}

interface RestorePayload {
  /** The entry. */
  e: string;
  /** The copy to go back to. */
  r: string;
  /** The entry's revision number right after the client's save. */
  v: number;
  /** When the link stops working (ms). */
  x: number;
}

export function makeRestoreToken(
  secrets: SiteSecrets,
  p: { entryId: string; copyId: string; revisionAfter: number },
  now: number = Date.now(),
): string {
  const payload: RestorePayload = {
    e: p.entryId,
    r: p.copyId,
    v: p.revisionAfter,
    x: now + RESTORE_DAYS * DAY,
  };
  return Buffer.from(secrets.seal(JSON.stringify(payload), PLACE)).toString("base64url");
}

export function readRestoreToken(
  secrets: SiteSecrets,
  token: unknown,
  now: number = Date.now(),
):
  | { ok: true; entryId: string; copyId: string; revisionAfter: number }
  | { ok: false; message: string } {
  const bad = { ok: false as const, message: "This restore link does not work." };
  if (typeof token !== "string" || token.length < 20 || token.length > 2000) return bad;
  try {
    const p = JSON.parse(
      secrets.open(Buffer.from(token, "base64url").toString("utf8"), PLACE),
    ) as RestorePayload;
    if (
      typeof p.e !== "string" ||
      typeof p.r !== "string" ||
      typeof p.v !== "number" ||
      typeof p.x !== "number"
    )
      return bad;
    if (now > p.x)
      return {
        ok: false,
        message: "This restore link has expired. Open the page and use its saved copies instead.",
      };
    return { ok: true, entryId: p.e, copyId: p.r, revisionAfter: p.v };
  } catch {
    return bad;
  }
}

export interface ClientEdit {
  entryId: string;
  typeKey: string;
  title: string;
  clientName: string;
  clientId: string;
  /** The copy that holds the page before the client's change, or null when none could be kept. */
  copyId: string | null;
  revisionAfter: number;
  /** The address of the page in the admin. */
  link: string;
  siteName: string;
  /** The address of this site, to build the restore link. */
  origin: string;
}

/**
 * Records a client's change to a live page, and tells the designers. The line in the audit log is always written; the email
 * only when the notice is on, email works, and the page has not been announced in the last 30 minutes. A failure here never
 * stops the save, so callers wrap it.
 */
export async function recordClientEdit(
  runner: SqlRunner,
  secrets: SiteSecrets,
  edit: ClientEdit,
  siteId: string,
  now: () => number = Date.now,
): Promise<{ notified: number }> {
  // A save that changed nothing is not a change: no line in the log, no email.
  if (edit.copyId && !(await changedSince(runner, siteId, edit.entryId, edit.copyId)))
    return { notified: 0 };
  await runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id", "detail", "created_at")
     values (?, ?, 'user', ?, 'content.client_edit', 'entry', ?, ?, ?)`,
    [
      newId(),
      siteId,
      edit.clientId,
      edit.entryId,
      JSON.stringify({
        title: edit.title,
        client: edit.clientName,
        copyId: edit.copyId,
        revisionAfter: edit.revisionAfter,
      }),
      new Date(now()),
    ],
  );
  return notify(runner, secrets, edit, siteId, now);
}

async function notify(
  runner: SqlRunner,
  secrets: SiteSecrets,
  edit: ClientEdit,
  siteId: string,
  now: () => number,
): Promise<{ notified: number }> {
  if (!edit.copyId || !(await clientNoticeOn(runner, siteId))) return { notified: 0 };
  const sent =
    ((await readSetting(runner, siteId, CLIENT_NOTICES_SENT_KEY)) as Record<
      string,
      number
    > | null) ?? {};
  if (typeof sent[edit.entryId] === "number" && now() - sent[edit.entryId]! < NOTICE_EVERY_MS)
    return { notified: 0 };
  const token = makeRestoreToken(
    secrets,
    { entryId: edit.entryId, copyId: edit.copyId, revisionAfter: edit.revisionAfter },
    now(),
  );
  const notified = await sendClientEditEmails(
    runner,
    siteId,
    secrets,
    {
      title: edit.title,
      client: edit.clientName,
      clientId: edit.clientId,
      siteName: edit.siteName,
      link: edit.link,
      restoreLink: `${edit.origin.replace(/\/$/, "")}/admin/restore/${token}`,
    },
    now,
  );
  if (notified > 0) {
    // Only the last day's entries are kept in the list.
    const fresh = Object.fromEntries(
      Object.entries(sent).filter(([, at]) => typeof at === "number" && now() - at < DAY),
    );
    fresh[edit.entryId] = now();
    await writeSetting(runner, siteId, CLIENT_NOTICES_SENT_KEY, fresh);
  }
  return { notified };
}

export interface ClientEditListed {
  entryId: string;
  title: string;
  client: string;
  at: number;
  copyId: string | null;
  revisionAfter: number;
  restored: boolean;
}

/** The latest changes clients made to live pages, newest first, for the Handoff screen (people who manage the settings). */
export async function listClientEdits(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  limit = 10,
): Promise<ClientEditListed[]> {
  if (!actor.can("settings.manage")) return [];
  const rows = await runner.all(
    `select "target_id", "detail", "created_at" from "audit_log" where "site_id" = ? and "action" = 'content.client_edit'
      order by "created_at" desc, "id" desc limit ${Math.min(Math.max(Math.trunc(limit), 1), 50)}`,
    [siteId],
  );
  const restored = await runner.all(
    `select "detail" from "audit_log" where "site_id" = ? and "action" = 'content.client_edit_restored'`,
    [siteId],
  );
  const done = new Set(
    restored.map((r) =>
      String((parse(runner, r["detail"]) as { copyId?: unknown } | null)?.copyId ?? ""),
    ),
  );
  return rows.map((r) => {
    const d = (parse(runner, r["detail"]) ?? {}) as Record<string, unknown>;
    const copyId = typeof d["copyId"] === "string" ? d["copyId"] : null;
    return {
      entryId: String(r["target_id"]),
      title: String(d["title"] ?? ""),
      client: String(d["client"] ?? ""),
      at: toMs(r["created_at"]),
      copyId,
      revisionAfter: Number(d["revisionAfter"] ?? 0),
      restored: copyId !== null && done.has(copyId),
    };
  });
}

type Fail = { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };

export interface ClientEditView {
  entryId: string;
  title: string;
  /** True when the page was saved again after the client's change (restoring would replace that too). */
  savedSince: boolean;
  compare: RevisionCompare;
}

/** What a restore link shows: the page, and what would change. Nothing is changed by looking. */
export async function describeClientEdit(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  token: unknown,
  now: () => number = Date.now,
): Promise<{ ok: true; view: ClientEditView } | Fail> {
  if (!actor.can("content.publish_any")) return forbidden();
  const read = readRestoreToken(secrets, token, now());
  if (!read.ok) return { ok: false, code: "invalid", message: read.message };
  const row = (
    await runner.all(
      `select "title", "revision" from "entries" where "id" = ? and "site_id" = ? and "status" <> 'trash'`,
      [read.entryId, siteId],
    )
  )[0];
  if (!row) return { ok: false, code: "not_found", message: "This page does not exist any more." };
  const compared = await compareRevision(runner, actor, siteId, read.entryId, read.copyId);
  if (!compared.ok)
    return { ok: false, code: "not_found", message: "The earlier version is not kept any more." };
  return {
    ok: true,
    view: {
      entryId: read.entryId,
      title: String(row["title"]),
      savedSince: Number(row["revision"]) > read.revisionAfter,
      compare: compared.compare,
    },
  };
}

const forbidden = (): Fail => ({
  ok: false,
  code: "forbidden",
  message: "Only people who may publish can put an earlier version back.",
});

/** Puts the earlier version back, as a new save of the live page (it stays live; nothing is unpublished). */
export async function restoreClientEdit(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  token: unknown,
  now: () => number = Date.now,
): Promise<{ ok: true; entryId: string; slug: string } | Fail> {
  if (!actor.can("content.publish_any")) return forbidden();
  const read = readRestoreToken(secrets, token, now());
  if (!read.ok) return { ok: false, code: "invalid", message: read.message };
  const row = (
    await runner.all(
      `select "revision" from "entries" where "id" = ? and "site_id" = ? and "status" <> 'trash'`,
      [read.entryId, siteId],
    )
  )[0];
  if (!row) return { ok: false, code: "not_found", message: "This page does not exist any more." };
  const saved = await restoreRevision(
    runner,
    actor,
    siteId,
    read.entryId,
    read.copyId,
    Number(row["revision"]),
    now,
  );
  if (!saved.ok)
    return {
      ok: false,
      code:
        saved.code === "forbidden"
          ? "forbidden"
          : saved.code === "not_found"
            ? "not_found"
            : "invalid",
      message: saved.message,
    };
  await runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id", "detail", "created_at")
     values (?, ?, 'user', ?, 'content.client_edit_restored', 'entry', ?, ?, ?)`,
    [
      newId(),
      siteId,
      actor.userId,
      read.entryId,
      JSON.stringify({ copyId: read.copyId }),
      new Date(now()),
    ],
  );
  return { ok: true, entryId: read.entryId, slug: saved.slug };
}
