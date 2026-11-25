// Client content collection (spec 11, section 8; AG-60 to AG-66, AG-88): a guided link that an agency gives to a client, where
// the client sends text and files for a page without an account. Rules:
//   - the link holds a random 256-bit token; only its SHA-256 is kept;
//   - it has limits (expiry, number of files, size, length of text) that hold across all the client's submissions;
//   - it can be turned off; a wrong, turned-off or expired link gets a plain message;
//   - text is stored as plain text (tags removed); a file goes through the same checks as an upload to the library and is kept
//     out of the public library, in the inbox, until a person of the site accepts it. Nothing is published by itself.
// Who may make links and read the inbox: people who manage the settings (an agency, not the client).
import { createHash, randomBytes } from "node:crypto";
import { checkUpload } from "@oks-page/media";
import { newId, type SqlRunner } from "@oks-page/db";
import { createDraft, saveContent, type Actor } from "./content.js";
import { uploadMedia, type MediaContext } from "./media.js";

export const COLLECT_LIMITS = {
  days: { default: 14, max: 90 },
  files: { default: 10, max: 10 },
  megabytes: { default: 50, max: 50 },
  text: { default: 20_000, max: 20_000 },
  label: 80,
  note: 500,
  sender: 80,
} as const;
const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

type Fail = { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };
const fail = (code: Fail["code"], message: string): Fail => ({ ok: false, code, message });

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const when = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const mayManage = (actor: Actor) => actor.can("settings.manage");

/** Text as the site keeps it: tags taken out, control characters gone (new lines stay), edges trimmed. */
export function plainText(input: string): string {
  return (
    input
      .replace(/<[^>]*>/g, "")
      .replace(/[<>]/g, "")
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim()
  );
}

const whole = (v: unknown, min: number, max: number, fallback: number): number | null => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export interface CollectLinkInput {
  label?: unknown;
  note?: unknown;
  days?: unknown;
  maxFiles?: unknown;
  maxMegabytes?: unknown;
  maxText?: unknown;
}

/** Makes a link. The answer holds the token once: it is not kept, so it cannot be shown again. */
export async function createCollectLink(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: CollectLinkInput,
  now: () => number = Date.now,
): Promise<{ ok: true; id: string; token: string; expiresAt: number } | Fail> {
  if (!mayManage(actor)) return fail("forbidden", "You may not make links for clients.");
  const label = typeof input.label === "string" ? plainText(input.label) : "";
  if (label === "" || label.length > COLLECT_LIMITS.label)
    return fail("invalid", `Say what it is for, in at most ${COLLECT_LIMITS.label} characters.`);
  const note = typeof input.note === "string" ? plainText(input.note) : "";
  if (note.length > COLLECT_LIMITS.note)
    return fail("invalid", `The note can be at most ${COLLECT_LIMITS.note} characters.`);
  const days = whole(input.days, 1, COLLECT_LIMITS.days.max, COLLECT_LIMITS.days.default);
  if (days === null)
    return fail("invalid", `The link can last from 1 to ${COLLECT_LIMITS.days.max} days.`);
  const files = whole(input.maxFiles, 0, COLLECT_LIMITS.files.max, COLLECT_LIMITS.files.default);
  if (files === null)
    return fail("invalid", `The number of files can be from 0 to ${COLLECT_LIMITS.files.max}.`);
  const mb = whole(
    input.maxMegabytes,
    1,
    COLLECT_LIMITS.megabytes.max,
    COLLECT_LIMITS.megabytes.default,
  );
  if (mb === null)
    return fail(
      "invalid",
      `The files can be from 1 to ${COLLECT_LIMITS.megabytes.max} MB together.`,
    );
  const text = whole(input.maxText, 0, COLLECT_LIMITS.text.max, COLLECT_LIMITS.text.default);
  if (text === null)
    return fail("invalid", `The text can be from 0 to ${COLLECT_LIMITS.text.max} characters.`);
  const token = randomBytes(32).toString("base64url");
  const id = newId();
  const at = now();
  const expiresAt = at + days * DAY;
  await runner.all(
    `insert into "collect_links" ("id", "site_id", "token_hash", "label", "note", "expires_at", "max_files", "max_bytes", "max_text", "created_by", "created_at")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      siteId,
      hashOf(token),
      label,
      note,
      new Date(expiresAt),
      files,
      mb * MB,
      text,
      actor.userId,
      new Date(at),
    ],
  );
  return { ok: true, id, token, expiresAt };
}

export type LinkState = "working" | "off" | "expired";

export interface CollectLinkView {
  id: string;
  label: string;
  note: string;
  state: LinkState;
  expiresAt: number;
  maxFiles: number;
  maxBytes: number;
  maxText: number;
  usedFiles: number;
  usedBytes: number;
  /** Characters of text taken so far (what was accepted still counts). */
  usedText: number;
  waiting: number;
  createdAt: number;
}

const stateOf = (row: Record<string, unknown>, at: number): LinkState =>
  row["disabled_at"] !== null && row["disabled_at"] !== undefined
    ? "off"
    : when(row["expires_at"]) <= at
      ? "expired"
      : "working";

/** What a link has taken so far (the limits hold across all submissions). */
async function usageOf(runner: SqlRunner, linkId: string) {
  const r = (
    await runner.all(
      `select
         coalesce(sum(case when "kind" = 'file' then 1 else 0 end), 0) as files,
         coalesce(sum(case when "kind" = 'file' then "size_bytes" else 0 end), 0) as bytes,
         coalesce(sum(case when "kind" = 'text' then "size_bytes" else 0 end), 0) as text,
         coalesce(sum(case when "status" = 'pending' then 1 else 0 end), 0) as waiting
       from "collect_items" where "link_id" = ?`,
      [linkId],
    )
  )[0]!;
  return {
    files: Number(r["files"]),
    bytes: Number(r["bytes"]),
    text: Number(r["text"]),
    waiting: Number(r["waiting"]),
  };
}

export async function listCollectLinks(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  now: () => number = Date.now,
): Promise<CollectLinkView[]> {
  if (!mayManage(actor)) return [];
  const rows = await runner.all(
    `select * from "collect_links" where "site_id" = ? order by "created_at" desc, "id" desc`,
    [siteId],
  );
  const out: CollectLinkView[] = [];
  for (const r of rows) {
    const used = await usageOf(runner, String(r["id"]));
    out.push({
      id: String(r["id"]),
      label: String(r["label"]),
      note: String(r["note"]),
      state: stateOf(r, now()),
      expiresAt: when(r["expires_at"]),
      maxFiles: Number(r["max_files"]),
      maxBytes: Number(r["max_bytes"]),
      maxText: Number(r["max_text"]),
      usedFiles: used.files,
      usedBytes: used.bytes,
      usedText: used.text,
      waiting: used.waiting,
      createdAt: when(r["created_at"]),
    });
  }
  return out;
}

/** Turns a link off, or on again (a link that has expired stays expired). */
export async function setCollectLinkOn(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  on: boolean,
  now: () => number = Date.now,
): Promise<{ ok: true } | Fail> {
  if (!mayManage(actor)) return fail("forbidden", "You may not change links for clients.");
  const found = await runner.all(
    `select "id" from "collect_links" where "id" = ? and "site_id" = ?`,
    [id, siteId],
  );
  if (found.length === 0) return fail("not_found", "This link does not exist.");
  await runner.all(`update "collect_links" set "disabled_at" = ? where "id" = ?`, [
    on ? null : new Date(now()),
    id,
  ]);
  return { ok: true };
}

export const LINK_MESSAGES = {
  unknown: "This link does not work.",
  off: "This link was turned off. Ask the person who sent it to you for a new one.",
  expired: "This link has expired. Ask the person who sent it to you for a new one.",
} as const;

export interface PublicLink {
  id: string;
  siteId: string;
  label: string;
  note: string;
  maxFiles: number;
  maxBytes: number;
  maxText: number;
  usedFiles: number;
  usedBytes: number;
  usedText: number;
}

/** Finds a link by the token a client holds. A wrong, turned-off or expired link gets its plain message. */
export async function openCollectLink(
  runner: SqlRunner,
  token: unknown,
  now: () => number = Date.now,
): Promise<
  | { ok: true; link: PublicLink }
  | { ok: false; reason: keyof typeof LINK_MESSAGES; message: string }
> {
  const no = (reason: keyof typeof LINK_MESSAGES) => ({
    ok: false as const,
    reason,
    message: LINK_MESSAGES[reason],
  });
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return no("unknown");
  const row = (
    await runner.all(`select * from "collect_links" where "token_hash" = ?`, [hashOf(token)])
  )[0];
  if (!row) return no("unknown");
  const state = stateOf(row, now());
  if (state === "off") return no("off");
  if (state === "expired") return no("expired");
  const used = await usageOf(runner, String(row["id"]));
  return {
    ok: true,
    link: {
      id: String(row["id"]),
      siteId: String(row["site_id"]),
      label: String(row["label"]),
      note: String(row["note"]),
      maxFiles: Number(row["max_files"]),
      maxBytes: Number(row["max_bytes"]),
      maxText: Number(row["max_text"]),
      usedFiles: used.files,
      usedBytes: used.bytes,
      usedText: used.text,
    },
  };
}

export interface Submission {
  sender?: unknown;
  text?: unknown;
  files?: { name: string; bytes: Uint8Array }[];
}

export type SubmitResult =
  | { ok: true; texts: number; files: number }
  | { ok: false; code: "invalid" | "closed"; message: string };

/**
 * What a client sends. Everything is checked first and everything is stored together, or nothing is: a client whose second
 * file is refused does not leave the first behind. The limits count what the link has already taken.
 */
export async function submitCollected(
  runner: SqlRunner,
  token: unknown,
  input: Submission,
  now: () => number = Date.now,
): Promise<SubmitResult> {
  const opened = await openCollectLink(runner, token, now);
  if (!opened.ok) return { ok: false, code: "closed", message: opened.message };
  const link = opened.link;
  const sender = typeof input.sender === "string" ? plainText(input.sender) : "";
  if (sender.length > COLLECT_LIMITS.sender)
    return {
      ok: false,
      code: "invalid",
      message: `The name can be at most ${COLLECT_LIMITS.sender} characters.`,
    };
  const text = typeof input.text === "string" ? plainText(input.text) : "";
  const files = input.files ?? [];
  if (text === "" && files.length === 0)
    return { ok: false, code: "invalid", message: "Write some text or choose a file to send." };
  if (text.length > 0 && link.usedText + text.length > link.maxText)
    return {
      ok: false,
      code: "invalid",
      message:
        link.maxText === 0
          ? "This link does not take text."
          : `Too much text. This link takes ${link.maxText.toLocaleString("en")} characters in all, and ${Math.max(0, link.maxText - link.usedText).toLocaleString("en")} are left.`,
    };
  if (link.usedFiles + files.length > link.maxFiles)
    return {
      ok: false,
      code: "invalid",
      message:
        link.maxFiles === 0
          ? "This link does not take files."
          : `Too many files. This link takes ${link.maxFiles} in all, and ${Math.max(0, link.maxFiles - link.usedFiles)} can still be sent.`,
    };
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (link.usedBytes + total > link.maxBytes)
    return {
      ok: false,
      code: "invalid",
      message: `The files are too big. This link takes ${Math.floor(link.maxBytes / MB)} MB in all.`,
    };
  const checked: { name: string; bytes: Uint8Array; mime: string }[] = [];
  for (const f of files) {
    // The checks of the media library; a picture with a script (SVG) is not taken from a client.
    const c = checkUpload(f.name, f.bytes, { canUploadSvg: false, maxBytes: link.maxBytes });
    if (!c.ok)
      return { ok: false, code: "invalid", message: `${f.name.slice(0, 80)}: ${c.reason}` };
    checked.push({ name: c.fileName, bytes: f.bytes, mime: c.type.mime });
  }
  const at = new Date(now());
  await runner.transaction(async (tx) => {
    if (text !== "")
      await tx.all(
        `insert into "collect_items" ("id", "link_id", "site_id", "kind", "sender", "body", "size_bytes", "status", "created_at")
         values (?, ?, ?, 'text', ?, ?, ?, 'pending', ?)`,
        [newId(), link.id, link.siteId, sender, text, text.length, at],
      );
    for (const f of checked)
      await tx.all(
        `insert into "collect_items" ("id", "link_id", "site_id", "kind", "sender", "file_name", "mime", "size_bytes", "data", "status", "created_at")
         values (?, ?, ?, 'file', ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          newId(),
          link.id,
          link.siteId,
          sender,
          f.name,
          f.mime,
          f.bytes.length,
          Buffer.from(f.bytes),
          at,
        ],
      );
  });
  return { ok: true, texts: text === "" ? 0 : 1, files: checked.length };
}

export interface InboxItem {
  id: string;
  linkId: string;
  linkLabel: string;
  kind: "text" | "file";
  sender: string;
  text: string;
  fileName: string | null;
  mime: string | null;
  sizeBytes: number;
  status: "pending" | "accepted";
  createdAt: number;
}

/** What clients sent, the newest first (the inbox). */
export async function listInbox(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
): Promise<InboxItem[]> {
  if (!mayManage(actor)) return [];
  const rows = await runner.all(
    `select i."id", i."link_id", l."label", i."kind", i."sender", i."body", i."file_name", i."mime", i."size_bytes", i."status", i."created_at"
     from "collect_items" i join "collect_links" l on l."id" = i."link_id"
     where i."site_id" = ? order by i."created_at" desc, i."id" desc`,
    [siteId],
  );
  return rows.map((r) => ({
    id: String(r["id"]),
    linkId: String(r["link_id"]),
    linkLabel: String(r["label"]),
    kind: String(r["kind"]) as "text" | "file",
    sender: String(r["sender"]),
    text: String(r["body"]),
    fileName: r["file_name"] === null ? null : String(r["file_name"]),
    mime: r["mime"] === null ? null : String(r["mime"]),
    sizeBytes: Number(r["size_bytes"]),
    status: String(r["status"]) as "pending" | "accepted",
    createdAt: when(r["created_at"]),
  }));
}

const text = (t: string) => ({ type: "text", text: t });
const paragraph = (t: string) => ({
  id: newId(),
  type: "paragraph",
  props: {},
  content: [text(t)],
  children: [],
});

/**
 * Accepts one item. A file goes into the media library through the normal upload (checked again, its sizes made), described
 * with who sent it. Text becomes a new draft page. Nothing is published. What the client sent is cleared from the inbox.
 */
export async function acceptCollected(
  runner: SqlRunner,
  ctx: MediaContext,
  actor: Actor,
  siteId: string,
  itemId: string,
): Promise<{ ok: true; kind: "text" | "file"; mediaId?: string; entryId?: string } | Fail> {
  if (!mayManage(actor)) return fail("forbidden", "You may not accept what clients send.");
  const row = (
    await runner.all(
      `select i.*, l."label" as link_label from "collect_items" i join "collect_links" l on l."id" = i."link_id"
       where i."id" = ? and i."site_id" = ?`,
      [itemId, siteId],
    )
  )[0];
  if (!row) return fail("not_found", "This item does not exist.");
  if (String(row["status"]) !== "pending")
    return fail("invalid", "This item was accepted already.");
  const sender = String(row["sender"]);
  const label = String(row["link_label"]);
  if (String(row["kind"]) === "file") {
    const stored = await uploadMedia(runner, ctx, actor, siteId, {
      fileName: String(row["file_name"]),
      bytes: new Uint8Array(row["data"] as Uint8Array),
    });
    if (!stored.ok) return fail("invalid", stored.message);
    await runner.all(`update "media" set "description" = ? where "id" = ?`, [
      `Sent${sender ? ` by ${sender}` : ""} for: ${label}`.slice(0, 500),
      stored.id,
    ]);
    await runner.all(
      `update "collect_items" set "status" = 'accepted', "data" = null where "id" = ?`,
      [itemId],
    );
    return { ok: true, kind: "file", mediaId: stored.id };
  }
  const title = `${label}${sender ? ` (from ${sender})` : ""}`.slice(0, 200);
  const made = await createDraft(runner, actor, siteId, { type: "page", title });
  if (!made.ok) return fail("invalid", made.message);
  const blocks = String(row["body"])
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map(paragraph);
  const saved = await saveContent(runner, actor, siteId, made.id, {
    title,
    slugPart: made.slug,
    status: "draft",
    blocks,
    revision: made.revision,
  });
  if (!saved.ok) return fail("invalid", saved.message);
  await runner.all(`update "collect_items" set "status" = 'accepted', "body" = '' where "id" = ?`, [
    itemId,
  ]);
  return { ok: true, kind: "text", entryId: made.id };
}

/** Throws away an item (what a client sent that the site does not want, or an accepted line that is not needed). */
export async function discardCollected(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  itemId: string,
): Promise<{ ok: true } | Fail> {
  if (!mayManage(actor)) return fail("forbidden", "You may not remove what clients send.");
  const found = await runner.all(
    `select "id" from "collect_items" where "id" = ? and "site_id" = ?`,
    [itemId, siteId],
  );
  if (found.length === 0) return fail("not_found", "This item does not exist.");
  await runner.all(`delete from "collect_items" where "id" = ?`, [itemId]);
  return { ok: true };
}
