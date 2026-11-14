// Settings > General (the site icon) and Settings > Writing (design batch 5).
//   The site icon: the small picture in the browser tab, chosen from the media library; square, at least 512 × 512.
//   Writing: the category and the layout a new post starts with. (The comment settings come with comments, M3; the
//   accessibility check while writing comes with the editor work.)
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import { layoutChoices } from "./owner-layouts.js";

export const SITE_ICON_KEY = "site-icon";
export const WRITING_SETTINGS_KEY = "writing";
export const SITE_ICON_MIN = 512;

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };
const forbidden: Fail = {
  ok: false,
  code: "forbidden",
  message: "You may not change the site settings.",
};

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
async function readSetting(runner: SqlRunner, siteId: string, key: string): Promise<unknown> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  return decode(runner, rows[0]?.["value"]);
}
async function writeSetting(runner: SqlRunner, siteId: string, key: string, value: unknown) {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date()],
  );
}
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ----- the site icon

export interface SiteIcon {
  mediaId: string;
  /** The storage key of the picture; the public address is made from it. */
  key: string;
  mime: string;
  width: number;
  height: number;
}

/** The site icon, or null when there is none (or its picture is gone or no longer fits). */
export async function loadSiteIcon(runner: SqlRunner, siteId: string): Promise<SiteIcon | null> {
  const stored = (await readSetting(runner, siteId, SITE_ICON_KEY)) as { mediaId?: unknown } | null;
  const mediaId =
    typeof stored?.mediaId === "string" && ID.test(stored.mediaId) ? stored.mediaId : null;
  if (!mediaId) return null;
  return iconOf(runner, siteId, mediaId);
}

async function iconOf(
  runner: SqlRunner,
  siteId: string,
  mediaId: string,
): Promise<SiteIcon | null> {
  const rows = await runner.all(
    `select "id", "storage_key", "mime_type", "width", "height", "status" from "media" where "id" = ? and "site_id" = ?`,
    [mediaId, siteId],
  );
  const r = rows[0];
  if (!r || String(r["status"]) !== "ready") return null;
  const mime = String(r["mime_type"]);
  const width = Number(r["width"]);
  const height = Number(r["height"]);
  if (!/^image\/(png|jpeg|webp|avif)$/.test(mime) || width !== height || width < SITE_ICON_MIN)
    return null;
  return { mediaId, key: String(r["storage_key"]), mime, width, height };
}

/** Chooses the site icon (or removes it with null). The picture must be a square of at least 512 × 512 in the library. */
export async function saveSiteIcon(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  mediaId: unknown,
): Promise<{ ok: true; icon: SiteIcon | null } | Fail> {
  if (!actor.can("settings.manage")) return forbidden;
  if (mediaId === null) {
    await writeSetting(runner, siteId, SITE_ICON_KEY, { mediaId: null });
    return { ok: true, icon: null };
  }
  if (typeof mediaId !== "string" || !ID.test(mediaId))
    return {
      ok: false,
      code: "invalid",
      message: "Choose a picture from the library.",
      field: "siteIcon",
    };
  const icon = await iconOf(runner, siteId, mediaId);
  if (!icon)
    return {
      ok: false,
      code: "invalid",
      message: `The site icon must be a square picture (PNG, JPEG, WebP or AVIF) of at least ${SITE_ICON_MIN} × ${SITE_ICON_MIN} pixels.`,
      field: "siteIcon",
    };
  await writeSetting(runner, siteId, SITE_ICON_KEY, { mediaId });
  return { ok: true, icon };
}

// ----- writing

export interface WritingSettings {
  /** The category a new post starts in, or null. */
  defaultCategoryId: string | null;
  /** The named layout a new post starts with ("custom-…"), or "" for the usual one. */
  defaultLayout: string;
}

export const DEFAULT_WRITING: WritingSettings = { defaultCategoryId: null, defaultLayout: "" };

export function readWritingSettings(raw: unknown): WritingSettings {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const category = v["defaultCategoryId"];
  const layout = v["defaultLayout"];
  return {
    defaultCategoryId: typeof category === "string" && ID.test(category) ? category : null,
    defaultLayout:
      typeof layout === "string" && /^custom-[a-z0-9-]{1,60}$/.test(layout) ? layout : "",
  };
}

export async function loadWritingSettings(
  runner: SqlRunner,
  siteId: string,
): Promise<WritingSettings> {
  return readWritingSettings(await readSetting(runner, siteId, WRITING_SETTINGS_KEY));
}

/** The categories of the site, for the choice. */
export async function listCategoryChoices(
  runner: SqlRunner,
  siteId: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await runner.all(
    `select t."id", t."name" from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
      where x."site_id" = ? and x."key" = 'category' order by t."name"`,
    [siteId],
  );
  return rows.map((r) => ({ id: String(r["id"]), name: String(r["name"]) }));
}

export async function saveWritingSettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: { defaultCategoryId?: unknown; defaultLayout?: unknown },
): Promise<{ ok: true; settings: WritingSettings } | Fail> {
  if (!actor.can("settings.manage")) return forbidden;
  const next = await loadWritingSettings(runner, siteId);
  if (input.defaultCategoryId !== undefined) {
    if (input.defaultCategoryId === null || input.defaultCategoryId === "")
      next.defaultCategoryId = null;
    else if (
      typeof input.defaultCategoryId === "string" &&
      (await listCategoryChoices(runner, siteId)).some((c) => c.id === input.defaultCategoryId)
    )
      next.defaultCategoryId = input.defaultCategoryId;
    else
      return {
        ok: false,
        code: "invalid",
        message: "Choose one of your categories.",
        field: "defaultCategoryId",
      };
  }
  if (input.defaultLayout !== undefined) {
    if (input.defaultLayout === "") next.defaultLayout = "";
    else if (
      typeof input.defaultLayout === "string" &&
      (await layoutChoices(runner, siteId)).some((l) => l.name === input.defaultLayout)
    )
      next.defaultLayout = input.defaultLayout;
    else
      return {
        ok: false,
        code: "invalid",
        message: "Choose a layout of the theme in use.",
        field: "defaultLayout",
      };
  }
  await writeSetting(runner, siteId, WRITING_SETTINGS_KEY, next);
  return { ok: true, settings: next };
}

/**
 * What a new post starts with: the default category (when it still exists) and the default layout (when the theme in
 * use still has it). Called when a post is created.
 */
export async function newPostDefaults(
  runner: SqlRunner,
  siteId: string,
): Promise<{ categoryId: string | null; layout: string }> {
  const s = await loadWritingSettings(runner, siteId);
  const categoryId =
    s.defaultCategoryId &&
    (await listCategoryChoices(runner, siteId)).some((c) => c.id === s.defaultCategoryId)
      ? s.defaultCategoryId
      : null;
  const layout =
    s.defaultLayout && (await layoutChoices(runner, siteId)).some((l) => l.name === s.defaultLayout)
      ? s.defaultLayout
      : "";
  return { categoryId, layout };
}
