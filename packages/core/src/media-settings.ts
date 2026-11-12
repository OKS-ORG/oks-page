// The media settings of a site (spec 09 section 9): the biggest file, the biggest picture and whether photo details
// (the place, the camera) are kept. They are stored in the site's `settings` table under the key `media`.
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_PIXELS } from "@oks-page/media";
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import type { MediaSettings } from "./media.js";

export const MEDIA_SETTINGS_KEY = "media";

/** What the settings screen shows: numbers people understand (megabytes and megapixels). */
export interface MediaSettingsForm {
  maxMegabytes: number;
  maxMegapixels: number;
  keepMetadata: boolean;
}

export const MEDIA_SETTINGS_LIMITS = {
  maxMegabytes: { min: 1, max: 200 },
  maxMegapixels: { min: 1, max: 200 },
} as const;

export const DEFAULT_MEDIA_SETTINGS: MediaSettingsForm = {
  maxMegabytes: DEFAULT_MAX_BYTES / (1024 * 1024),
  maxMegapixels: DEFAULT_MAX_PIXELS / 1_000_000,
  keepMetadata: false,
};

export type MediaSettingsResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "invalid"; message: string };

const asObject = (raw: unknown): Record<string, unknown> => {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
};
const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const inRange = (v: unknown, range: { min: number; max: number }): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= range.min && v <= range.max;

/** The saved settings, with the default for anything missing or damaged. */
export async function loadMediaSettingsForm(
  runner: SqlRunner,
  siteId: string,
): Promise<MediaSettingsForm> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, MEDIA_SETTINGS_KEY],
  );
  const saved = rows[0] ? asObject(rows[0]["value"]) : {};
  return {
    maxMegabytes: inRange(saved["maxMegabytes"], MEDIA_SETTINGS_LIMITS.maxMegabytes)
      ? saved["maxMegabytes"]
      : DEFAULT_MEDIA_SETTINGS.maxMegabytes,
    maxMegapixels: inRange(saved["maxMegapixels"], MEDIA_SETTINGS_LIMITS.maxMegapixels)
      ? saved["maxMegapixels"]
      : DEFAULT_MEDIA_SETTINGS.maxMegapixels,
    keepMetadata: saved["keepMetadata"] === true,
  };
}

/** The settings in the shape the media code uses (bytes and pixels). */
export async function loadMediaSettings(runner: SqlRunner, siteId: string): Promise<MediaSettings> {
  const form = await loadMediaSettingsForm(runner, siteId);
  return {
    maxBytes: Math.round(form.maxMegabytes * 1024 * 1024),
    maxPixels: Math.round(form.maxMegapixels * 1_000_000),
    keepMetadata: form.keepMetadata,
  };
}

/** Saves the settings. Only people who may manage the settings can; every value is checked first. */
export async function saveMediaSettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: Partial<MediaSettingsForm>,
): Promise<MediaSettingsResult<{ settings: MediaSettingsForm }>> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the settings." };
  const current = await loadMediaSettingsForm(runner, siteId);
  const next: MediaSettingsForm = {
    maxMegabytes: input.maxMegabytes ?? current.maxMegabytes,
    maxMegapixels: input.maxMegapixels ?? current.maxMegapixels,
    keepMetadata: input.keepMetadata ?? current.keepMetadata,
  };
  const { maxMegabytes: mb, maxMegapixels: mp } = MEDIA_SETTINGS_LIMITS;
  if (!inRange(next.maxMegabytes, mb))
    return {
      ok: false,
      code: "invalid",
      message: `The biggest file must be a number from ${mb.min} to ${mb.max} MB.`,
    };
  if (!inRange(next.maxMegapixels, mp))
    return {
      ok: false,
      code: "invalid",
      message: `The biggest picture must be a number from ${mp.min} to ${mp.max} megapixels.`,
    };
  if (typeof next.keepMetadata !== "boolean")
    return { ok: false, code: "invalid", message: "Keep photo details must be on or off." };
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, MEDIA_SETTINGS_KEY, JSON.stringify(next), new Date()],
  );
  return { ok: true, settings: next };
}
