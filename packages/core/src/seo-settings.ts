// The "search engines" setting (spec 07, settings; spec 08, section 8): ask search engines not to index the site, for
// example while it is being built. It is kept in the site's `settings` table under the key `seo`.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const SEO_SETTINGS_KEY = "seo";

export interface SeoSettings {
  /** True: robots.txt closes everything, no sitemap is listed, and every public page says `noindex, nofollow`. */
  discourageIndexing: boolean;
}

export const DEFAULT_SEO_SETTINGS: SeoSettings = { discourageIndexing: false };

export type SeoResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "invalid"; message: string };

/** On only when the saved value says so; anything damaged means the site is open to search engines. */
export function readSeoSettings(raw: unknown): SeoSettings {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  const saved = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { discourageIndexing: saved["discourageIndexing"] === true };
}

export async function loadSeoSettings(runner: SqlRunner, siteId: string): Promise<SeoSettings> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, SEO_SETTINGS_KEY],
  );
  return readSeoSettings(rows[0]?.["value"]);
}

export async function saveSeoSettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: Partial<SeoSettings>,
): Promise<SeoResult<{ settings: SeoSettings }>> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the settings." };
  const current = await loadSeoSettings(runner, siteId);
  const discourageIndexing = input.discourageIndexing ?? current.discourageIndexing;
  if (typeof discourageIndexing !== "boolean")
    return { ok: false, code: "invalid", message: "The choice must be on or off." };
  const next: SeoSettings = { discourageIndexing };
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, SEO_SETTINGS_KEY, JSON.stringify(next), new Date()],
  );
  return { ok: true, settings: next };
}
