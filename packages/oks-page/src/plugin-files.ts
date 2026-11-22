// The files visitors send to a plugin (spec 16, section 6; permission `files:private`). The site reads and checks the files,
// keeps them in its own database (never in the public Media library and never at a public address), and gives the plugin
// only a reference to each. A file is `pending` for an hour; if the plugin attaches it to one of its stored items it is
// `kept` with that item and goes when the item is deleted. Only people who manage plugins may open a kept file, through an
// admin address.
import type { Actor } from "@oks-page/core";
import { newId, type SqlRunner } from "@oks-page/db";
import { checkUpload } from "@oks-page/media";
import type { RouteFile } from "@oks-page/sandbox";
import { createHash } from "node:crypto";

/** Files that arrived and wait to be attached may not add up to more than this for one plugin (so a program cannot fill the
 * database by sending files to a form that has no file field). */
export const PENDING_BYTES_MOST = 50 * 1024 * 1024;
/** How long a file that was not attached is kept. */
export const PENDING_KEEP_MS = 60 * 60 * 1000;
/** Pictures and PDF files only: the types of the Media library that are documents or images. */
const KINDS = new Set(["image", "pdf"]);

export type ReceiveResult = { ok: true; files: RouteFile[] } | { ok: false; message: string };

// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A name that is safe and short to show in a message about it. */
const shown = (name: string): string => {
  const last = name.replace(CONTROL, "").split(/[\\/]/).pop() ?? "";
  return last.slice(0, 60) || "A file";
};

/**
 * Checks the files of one request and keeps them. Every file is checked before any is kept: its type is read from its bytes
 * (the same check as for the Media library), the name must agree with it, and the size and the number are limited.
 */
export async function receiveFiles(
  runner: SqlRunner,
  extensionId: string,
  limits: { files: number; maxFileBytes: number },
  parts: { field: string; name: string; bytes: Uint8Array }[],
  now: () => number = Date.now,
): Promise<ReceiveResult> {
  if (parts.length > limits.files)
    return { ok: false, message: `At most ${limits.files} files can be sent at once.` };
  const checked: { field: string; name: string; mime: string; bytes: Uint8Array }[] = [];
  for (const p of parts) {
    const r = checkUpload(p.name, p.bytes, { canUploadSvg: false, maxBytes: limits.maxFileBytes });
    if (!r.ok) return { ok: false, message: `${shown(p.name)}: ${r.reason}` };
    if (!KINDS.has(r.type.kind))
      return { ok: false, message: `${shown(p.name)}: Only pictures and PDF files can be sent.` };
    checked.push({ field: p.field, name: r.fileName, mime: r.type.mime, bytes: p.bytes });
  }
  const adding = checked.reduce((n, f) => n + f.bytes.length, 0);
  const waiting = Number(
    (
      await runner.all(
        `select coalesce(sum("size_bytes"), 0) as "used" from "extension_files" where "extension_id" = ? and "status" = 'pending'`,
        [extensionId],
      )
    )[0]?.["used"] ?? 0,
  );
  if (waiting + adding > PENDING_BYTES_MOST)
    return {
      ok: false,
      message: "Too many files are being sent right now. Please try again in a few minutes.",
    };
  const out: RouteFile[] = [];
  for (const f of checked) {
    const id = newId();
    await runner.all(
      `insert into "extension_files" ("id", "extension_id", "name", "mime", "size_bytes", "sha256", "status", "data", "created_at")
       values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        id,
        extensionId,
        f.name,
        f.mime,
        f.bytes.length,
        createHash("sha256").update(f.bytes).digest("hex"),
        Buffer.from(f.bytes),
        new Date(now()),
      ],
    );
    out.push({ field: f.field, id, name: f.name, type: f.mime, size: f.bytes.length });
  }
  return { ok: true, files: out };
}

/** Deletes the files that were received and never attached to an item. Returns how many went. */
export async function purgePendingFiles(
  runner: SqlRunner,
  now: () => number = Date.now,
): Promise<number> {
  const rows = await runner.all(
    `delete from "extension_files" where "status" = 'pending' and "created_at" < ? returning "id"`,
    [new Date(now() - PENDING_KEEP_MS)],
  );
  return rows.length;
}

/** Deletes the files kept with one stored item of a plugin (when the item is deleted from the admin). */
export async function deleteItemFiles(
  runner: SqlRunner,
  extensionId: string,
  collection: string,
  key: string,
): Promise<void> {
  await runner.all(
    `delete from "extension_files" where "extension_id" = ? and "collection" = ? and "key" = ?`,
    [extensionId, collection, key],
  );
}

export type OpenResult =
  | { ok: true; name: string; mime: string; bytes: Buffer; plugin: string }
  | { ok: false; code: "forbidden" | "not_found"; message: string };

/** A kept file, for a person who may manage plugins. A file that is still pending, or another site's, is not found. */
export async function openPluginFile(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<OpenResult> {
  if (!actor.can("plugins.manage"))
    return { ok: false, code: "forbidden", message: "You may not manage plugins." };
  const row = (
    await runner.all(
      `select f."name", f."mime", f."data", e."key" as "plugin" from "extension_files" f
         join "extensions" e on e."id" = f."extension_id"
        where f."id" = ? and e."site_id" = ? and f."status" = 'kept'`,
      [id, siteId],
    )
  )[0];
  if (!row) return { ok: false, code: "not_found", message: "This file does not exist." };
  return {
    ok: true,
    name: String(row["name"]),
    mime: String(row["mime"]),
    bytes: Buffer.from(row["data"] as Uint8Array),
    plugin: String(row["plugin"]),
  };
}
