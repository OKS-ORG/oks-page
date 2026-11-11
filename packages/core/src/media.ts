// Media as the admin works with it (spec 09 sections 3, 8 and 9): upload, the background job that makes the sizes, the
// library list, edits to the descriptions, delete (refused while a file is in use) and finding a file to serve.
import { createHash } from "node:crypto";
import {
  buildKey,
  checkUpload,
  cleanSvg,
  ImageRefused,
  makeBlurPlaceholder,
  makeVariants,
  prepareImage,
  SvgRefused,
  type StorageAdapter,
} from "@oks-page/media";
import { newId, type SqlRunner } from "@oks-page/db";
import { enqueueJob, PermanentJobError, type Job, type JobHandler } from "./jobs.js";
import type { Actor } from "./content.js";

export const MEDIA_JOB = "media.variants";

export type MediaErrorCode = "forbidden" | "not_found" | "invalid" | "in_use";

export interface MediaUse {
  id: string;
  title: string;
  type: string;
}

export type MediaResult<T> =
  ({ ok: true } & T) | { ok: false; code: MediaErrorCode; message: string; usedIn?: MediaUse[] };

const fail = (
  code: MediaErrorCode,
  message: string,
  usedIn?: MediaUse[],
): { ok: false; code: MediaErrorCode; message: string; usedIn?: MediaUse[] } => ({
  ok: false,
  code,
  message,
  ...(usedIn ? { usedIn } : {}),
});

/** What the admin may change in the media settings of the site (Settings later; defaults now). */
export interface MediaSettings {
  maxBytes?: number;
  maxPixels?: number;
  keepMetadata?: boolean;
}

export interface MediaContext {
  storage: StorageAdapter;
  settings?: MediaSettings;
  now?: () => number;
}

export interface MediaVariantInfo {
  width: number;
  format: string;
  url: string;
}

export interface MediaItem {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  alt: string;
  caption: string;
  title: string;
  description: string;
  focalX: number | null;
  focalY: number | null;
  blurPlaceholder: string | null;
  status: "processing" | "ready" | "failed";
  uploadedBy: string;
  createdAt: number;
  folderId: string | null;
  url: string;
  variants: MediaVariantInfo[];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const when = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

/** The file name people see: the key is `yyyy/mm/<id>-<name>`. */
const nameFromRow = (row: Record<string, unknown>): string => String(row["filename"]);

function toItem(
  row: Record<string, unknown>,
  storage: StorageAdapter,
  variants: MediaVariantInfo[],
): MediaItem {
  return {
    id: String(row["id"]),
    fileName: nameFromRow(row),
    mimeType: String(row["mime_type"]),
    sizeBytes: Number(row["size_bytes"]),
    width: num(row["width"]),
    height: num(row["height"]),
    alt: String(row["alt"]),
    caption: String(row["caption"]),
    title: String(row["title"]),
    description: String(row["description"]),
    focalX: num(row["focal_x"]),
    focalY: num(row["focal_y"]),
    blurPlaceholder: row["blur_placeholder"] === null ? null : String(row["blur_placeholder"]),
    status: String(row["status"]) as MediaItem["status"],
    uploadedBy: String(row["uploaded_by"]),
    createdAt: when(row["created_at"]),
    folderId: row["folder_id"] === null ? null : String(row["folder_id"]),
    url: storage.publicUrl(String(row["storage_key"])),
    variants,
  };
}

async function variantsOf(
  runner: SqlRunner,
  storage: StorageAdapter,
  ids: string[],
): Promise<Map<string, MediaVariantInfo[]>> {
  const out = new Map<string, MediaVariantInfo[]>();
  if (ids.length === 0) return out;
  const rows = await runner.all(
    `select "media_id", "width", "format", "storage_key" from "media_variants" where "media_id" in (${ids.map(() => "?").join(", ")}) order by "width", "format"`,
    ids,
  );
  for (const r of rows) {
    const list = out.get(String(r["media_id"])) ?? [];
    list.push({
      width: Number(r["width"]),
      format: String(r["format"]),
      url: storage.publicUrl(String(r["storage_key"])),
    });
    out.set(String(r["media_id"]), list);
  }
  return out;
}

const canSee = (actor: Actor) =>
  actor.can("media.upload") || actor.can("media.edit_own") || actor.can("media.edit_any");

// ---------------------------------------------------------------------------------------------------------------- upload

export interface UploadInput {
  fileName: string;
  bytes: Uint8Array;
  folderId?: string | null;
}

/**
 * Checks, cleans and stores one file. A raster image is stored at once with the status `processing`, and a job makes
 * its sizes. Nothing is stored when a check refuses the file.
 */
export async function uploadMedia(
  runner: SqlRunner,
  ctx: MediaContext,
  actor: Actor,
  siteId: string,
  input: UploadInput,
): Promise<
  MediaResult<{ id: string; status: MediaItem["status"]; url: string; fileName: string }>
> {
  if (!actor.can("media.upload")) return fail("forbidden", "You may not upload files.");
  const settings = ctx.settings ?? {};
  const checked = checkUpload(input.fileName, input.bytes, {
    canUploadSvg: actor.can("media.upload_svg"),
    ...(settings.maxBytes ? { maxBytes: settings.maxBytes } : {}),
  });
  if (!checked.ok) return fail(checked.forbidden ? "forbidden" : "invalid", checked.reason);

  let stored: Uint8Array = input.bytes;
  let width: number | null = null;
  let height: number | null = null;
  let needsSizes = false;
  try {
    if (checked.type.kind === "svg") {
      stored = new TextEncoder().encode(await cleanSvg(input.bytes));
    } else if (checked.type.kind === "image") {
      const prepared = await prepareImage(input.bytes, {
        ...(settings.maxPixels ? { maxPixels: settings.maxPixels } : {}),
        ...(settings.keepMetadata ? { keepMetadata: true } : {}),
      });
      stored = prepared.original;
      width = prepared.width;
      height = prepared.height;
      needsSizes = !prepared.animated;
    }
  } catch (error) {
    if (error instanceof ImageRefused || error instanceof SvgRefused) {
      return fail("invalid", error.message);
    }
    throw error;
  }

  if (input.folderId) {
    const folder = await runner.all(
      `select 1 as found from "media_folders" where "id" = ? and "site_id" = ?`,
      [input.folderId, siteId],
    );
    if (folder.length === 0) return fail("invalid", "That folder does not exist.");
  }

  const now = ctx.now ?? Date.now;
  const id = newId();
  const key = buildKey(id, checked.fileName, new Date(now()));
  const status: MediaItem["status"] = needsSizes ? "processing" : "ready";
  await ctx.storage.put(key, stored);
  try {
    await runner.all(
      `insert into "media" ("id", "site_id", "folder_id", "storage_key", "filename", "mime_type", "size_bytes", "width", "height", "alt", "caption", "title", "description", "content_hash", "status", "uploaded_by", "created_at")
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', '', ?, ?, ?, ?)`,
      [
        id,
        siteId,
        input.folderId ?? null,
        key,
        checked.fileName,
        checked.type.mime,
        stored.length,
        width,
        height,
        createHash("sha256").update(stored).digest("hex"),
        status,
        actor.userId,
        new Date(now()),
      ],
    );
    if (needsSizes) await enqueueJob(runner, siteId, MEDIA_JOB, { mediaId: id }, now);
  } catch (error) {
    await ctx.storage.delete(key).catch(() => undefined);
    throw error;
  }
  return { ok: true, id, status, url: ctx.storage.publicUrl(key), fileName: checked.fileName };
}

// ------------------------------------------------------------------------------------------------------------------ job

const keyBase = (key: string): string => key.replace(/\.[^./]+$/, "");

/** The background work for one image: make the sizes and the blur placeholder, then mark the file ready. */
async function makeSizes(runner: SqlRunner, ctx: MediaContext, mediaId: string): Promise<void> {
  const rows = await runner.all(`select "storage_key", "status" from "media" where "id" = ?`, [
    mediaId,
  ]);
  const row = rows[0];
  if (!row) return; // deleted while it waited
  if (String(row["status"]) === "ready") return;
  const key = String(row["storage_key"]);
  const bytes = await ctx.storage.get(key);
  const opts = ctx.settings?.maxPixels ? { maxPixels: ctx.settings.maxPixels } : {};
  let variants;
  let blur;
  try {
    variants = await makeVariants(bytes, opts);
    blur = await makeBlurPlaceholder(bytes, opts);
  } catch (error) {
    if (error instanceof ImageRefused) throw new PermanentJobError(error.message);
    throw error;
  }
  const written: string[] = [];
  for (const v of variants) {
    const variantKey = `${keyBase(key)}-${v.width}.${v.format}`;
    await ctx.storage.put(variantKey, v.bytes);
    written.push(variantKey);
  }
  await runner.transaction(async (tx) => {
    await tx.all(`delete from "media_variants" where "media_id" = ?`, [mediaId]);
    for (const [i, v] of variants.entries()) {
      await tx.all(
        `insert into "media_variants" ("media_id", "width", "format", "storage_key", "size_bytes") values (?, ?, ?, ?, ?)`,
        [mediaId, v.width, v.format, written[i]!, v.bytes.length],
      );
    }
    await tx.all(`update "media" set "status" = 'ready', "blur_placeholder" = ? where "id" = ?`, [
      blur,
      mediaId,
    ]);
  });
}

/** The job handler for `media.variants`. Hand it to `drainJobs`. */
export function mediaJobHandler(runner: SqlRunner, ctx: MediaContext): JobHandler {
  const idOf = (job: Job) => String((job.payload as { mediaId?: unknown }).mediaId ?? "");
  return {
    run: (job) => makeSizes(runner, ctx, idOf(job)),
    // The reason stays in the job row (`last_error`); the file is shown as failed.
    giveUp: async (job) => {
      await runner.all(`update "media" set "status" = 'failed' where "id" = ?`, [idOf(job)]);
    },
  };
}

// ------------------------------------------------------------------------------------------------------------------ read

export interface ListOptions {
  search?: string;
  kind?: "image" | "pdf" | "video" | "audio" | "other";
  unused?: boolean;
  folderId?: string | null;
  limit?: number;
  offset?: number;
}

const KIND_SQL: Record<NonNullable<ListOptions["kind"]>, string> = {
  image: `"mime_type" like 'image/%'`,
  pdf: `"mime_type" = 'application/pdf'`,
  video: `"mime_type" like 'video/%'`,
  audio: `"mime_type" like 'audio/%'`,
  other: `("mime_type" not like 'image/%' and "mime_type" not like 'video/%' and "mime_type" not like 'audio/%' and "mime_type" <> 'application/pdf')`,
};

/** The library list, newest first. Someone who may only edit their own files sees only their own. */
export async function listMedia(
  runner: SqlRunner,
  ctx: MediaContext,
  actor: Actor,
  siteId: string,
  options: ListOptions = {},
): Promise<MediaResult<{ items: MediaItem[]; total: number }>> {
  if (!canSee(actor)) return fail("forbidden", "You may not see the media library.");
  const where: string[] = [`"site_id" = ?`];
  const params: unknown[] = [siteId];
  if (!actor.can("media.edit_any")) {
    where.push(`"uploaded_by" = ?`);
    params.push(actor.userId);
  }
  if (options.search?.trim()) {
    const like = `%${options.search
      .trim()
      .toLowerCase()
      .replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    where.push(
      `(lower("filename") like ? escape '\\' or lower("alt") like ? escape '\\' or lower("title") like ? escape '\\')`,
    );
    params.push(like, like, like);
  }
  if (options.kind) where.push(KIND_SQL[options.kind]);
  if (options.unused)
    where.push(`not exists (select 1 from "entry_media" em where em."media_id" = "media"."id")`);
  if (options.folderId !== undefined) {
    if (options.folderId === null) where.push(`"folder_id" is null`);
    else {
      where.push(`"folder_id" = ?`);
      params.push(options.folderId);
    }
  }
  const clause = where.join(" and ");
  const total = Number(
    (await runner.all(`select count(*) as n from "media" where ${clause}`, params))[0]!["n"],
  );
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
  const rows = await runner.all(
    `select * from "media" where ${clause} order by "created_at" desc, "id" desc limit ? offset ?`,
    [...params, limit, Math.max(options.offset ?? 0, 0)],
  );
  const variants = await variantsOf(
    runner,
    ctx.storage,
    rows.map((r) => String(r["id"])),
  );
  return {
    ok: true,
    total,
    items: rows.map((r) => toItem(r, ctx.storage, variants.get(String(r["id"])) ?? [])),
  };
}

async function usesOf(runner: SqlRunner, mediaId: string): Promise<MediaUse[]> {
  const rows = await runner.all(
    `select distinct e."id", e."title", e."type_key" from "entry_media" em join "entries" e on e."id" = em."entry_id"
     where em."media_id" = ? and e."status" <> 'trash' order by e."title"`,
    [mediaId],
  );
  return rows.map((r) => ({
    id: String(r["id"]),
    title: String(r["title"]),
    type: String(r["type_key"]),
  }));
}

async function load(
  runner: SqlRunner,
  siteId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const rows = await runner.all(`select * from "media" where "id" = ? and "site_id" = ?`, [
    id,
    siteId,
  ]);
  return rows[0] ?? null;
}

const mayEdit = (actor: Actor, row: Record<string, unknown>) =>
  actor.can("media.edit_any") ||
  (actor.can("media.edit_own") && String(row["uploaded_by"]) === actor.userId);

/** One file with the pages that use it (the "Used in" list). */
export async function getMedia(
  runner: SqlRunner,
  ctx: MediaContext,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<MediaResult<{ item: MediaItem; usedIn: MediaUse[]; canEdit: boolean }>> {
  if (!canSee(actor)) return fail("forbidden", "You may not see the media library.");
  const row = await load(runner, siteId, id);
  if (!row) return fail("not_found", "That file does not exist.");
  const own = String(row["uploaded_by"]) === actor.userId;
  if (!actor.can("media.edit_any") && !own) return fail("not_found", "That file does not exist.");
  const variants = await variantsOf(runner, ctx.storage, [id]);
  return {
    ok: true,
    item: toItem(row, ctx.storage, variants.get(id) ?? []),
    usedIn: await usesOf(runner, id),
    canEdit: mayEdit(actor, row),
  };
}

// ----------------------------------------------------------------------------------------------------------------- edit

export interface MediaPatch {
  alt?: string;
  caption?: string;
  title?: string;
  description?: string;
  focalX?: number | null;
  focalY?: number | null;
}

const LIMITS = { alt: 500, caption: 1000, title: 200, description: 2000 } as const;

export async function updateMedia(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  patch: MediaPatch,
): Promise<MediaResult<{ usedIn: string[] }>> {
  const row = await load(runner, siteId, id);
  if (!row || (!actor.can("media.edit_any") && String(row["uploaded_by"]) !== actor.userId))
    return fail("not_found", "That file does not exist.");
  if (!mayEdit(actor, row)) return fail("forbidden", "You may not change this file.");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of ["alt", "caption", "title", "description"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return fail("invalid", `The ${key} must be text.`);
    if (value.length > LIMITS[key])
      return fail("invalid", `The ${key} can be at most ${LIMITS[key]} characters.`);
    sets.push(`"${key}" = ?`);
    params.push(value);
  }
  if (patch.focalX !== undefined || patch.focalY !== undefined) {
    const x = patch.focalX ?? null;
    const y = patch.focalY ?? null;
    const ok = (v: number | null) => v === null || (Number.isFinite(v) && v >= 0 && v <= 1);
    if (!ok(x) || !ok(y) || (x === null) !== (y === null))
      return fail("invalid", "The focal point needs both values, from 0 to 1.");
    sets.push(`"focal_x" = ?`, `"focal_y" = ?`);
    params.push(x, y);
  }
  if (sets.length > 0) {
    await runner.all(`update "media" set ${sets.join(", ")} where "id" = ?`, [...params, id]);
  }
  return { ok: true, usedIn: (await usesOf(runner, id)).map((u) => u.id) };
}

// --------------------------------------------------------------------------------------------------------------- delete

/** Deletes a file and its sizes. A file that is in use is refused, with the list of pages that use it (MD-35). */
export async function deleteMedia(
  runner: SqlRunner,
  ctx: MediaContext,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<MediaResult<object>> {
  const row = await load(runner, siteId, id);
  if (!row || (!actor.can("media.edit_any") && String(row["uploaded_by"]) !== actor.userId))
    return fail("not_found", "That file does not exist.");
  if (!actor.can("media.delete_any")) return fail("forbidden", "You may not delete files.");
  const used = await usesOf(runner, id);
  if (used.length > 0) {
    return fail("in_use", "This file is used by the pages below. Remove it from them first.", used);
  }
  const keys = [
    String(row["storage_key"]),
    ...(
      await runner.all(`select "storage_key" from "media_variants" where "media_id" = ?`, [id])
    ).map((r) => String(r["storage_key"])),
  ];
  await runner.transaction(async (tx) => {
    await tx.all(`delete from "media_variants" where "media_id" = ?`, [id]);
    await tx.all(`delete from "media" where "id" = ?`, [id]);
  });
  for (const key of keys) await ctx.storage.delete(key).catch(() => undefined);
  return { ok: true };
}

// ----------------------------------------------------------------------------------------------------------- serving

export interface ServedFile {
  key: string;
  mimeType: string;
  fileName: string;
}

const VARIANT_MIME: Record<string, string> = { webp: "image/webp", avif: "image/avif" };

/** Finds the file a stored key belongs to, for the public file route. The type comes from the database. */
export async function findFile(
  runner: SqlRunner,
  siteId: string,
  key: string,
): Promise<ServedFile | null> {
  const original = (
    await runner.all(
      `select "mime_type", "filename" from "media" where "site_id" = ? and "storage_key" = ?`,
      [siteId, key],
    )
  )[0];
  if (original)
    return {
      key,
      mimeType: String(original["mime_type"]),
      fileName: String(original["filename"]),
    };
  const variant = (
    await runner.all(
      `select v."format", v."width", m."filename" from "media_variants" v join "media" m on m."id" = v."media_id"
       where m."site_id" = ? and v."storage_key" = ?`,
      [siteId, key],
    )
  )[0];
  if (!variant) return null;
  const format = String(variant["format"]);
  const base = String(variant["filename"]).replace(/\.[^.]+$/, "");
  return {
    key,
    mimeType: VARIANT_MIME[format] ?? "application/octet-stream",
    fileName: `${base}-${Number(variant["width"])}.${format}`,
  };
}
