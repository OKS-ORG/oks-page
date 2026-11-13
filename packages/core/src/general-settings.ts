// The general settings of a site (Settings > General): its name, its tagline and its time zone. They are kept in the
// site's `settings` table under the keys `title`, `tagline` and `timezone` (as the setup wizard writes them), and the name
// is also kept in the `sites` table, where the dashboard reads it.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import { isValidTimeZone } from "./timezone.js";

export const SITE_NAME_MAX = 100;
export const TAGLINE_MAX = 200;

export interface GeneralSettings {
  siteName: string;
  tagline: string;
  /** A time zone name ("Asia/Kolkata"), or null for "automatic": each person's own browser decides. */
  timeZone: string | null;
}

export type GeneralResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

/**
 * What a stored JSON value means. PostgreSQL's driver has already read the JSON, so a stored text value arrives as plain
 * text; SQLite keeps JSON as text, so a stored text value arrives with its quotes and has to be read.
 */
const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export async function loadGeneralSettings(
  runner: SqlRunner,
  siteId: string,
): Promise<GeneralSettings> {
  const rows = await runner.all(
    `select "key", "value" from "settings" where "site_id" = ? and "key" in ('title', 'tagline', 'timezone')`,
    [siteId],
  );
  const value = (key: string): unknown =>
    decode(runner, rows.find((r) => r["key"] === key)?.["value"]);
  const site = await runner.all(`select "name" from "sites" where "id" = ?`, [siteId]);
  const title = value("title");
  const tagline = value("tagline");
  const zone = value("timezone");
  return {
    siteName: typeof title === "string" && title ? title : String(site[0]?.["name"] ?? ""),
    tagline: typeof tagline === "string" ? tagline : "",
    timeZone: typeof zone === "string" && isValidTimeZone(zone) ? zone : null,
  };
}

const upsert = (runner: SqlRunner, siteId: string, key: string, value: unknown) =>
  runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date()],
  );

/** Saves the general settings; only the parts that are given change. Needs `settings.manage`. */
export async function saveGeneralSettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: Partial<GeneralSettings>,
): Promise<GeneralResult<{ settings: GeneralSettings }>> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the settings." };
  const current = await loadGeneralSettings(runner, siteId);
  const bad = (field: string, message: string) =>
    ({ ok: false, code: "invalid", field, message }) as const;

  let siteName = current.siteName;
  if (input.siteName !== undefined) {
    if (typeof input.siteName !== "string")
      return bad("siteName", "The site name was not understood.");
    siteName = input.siteName.trim();
    if (!siteName) return bad("siteName", "Enter a name for the site.");
    if (Array.from(siteName).length > SITE_NAME_MAX)
      return bad("siteName", `The site name can be at most ${SITE_NAME_MAX} characters.`);
  }
  let tagline = current.tagline;
  if (input.tagline !== undefined) {
    if (typeof input.tagline !== "string") return bad("tagline", "The tagline was not understood.");
    tagline = input.tagline.trim();
    if (Array.from(tagline).length > TAGLINE_MAX)
      return bad("tagline", `The tagline can be at most ${TAGLINE_MAX} characters.`);
  }
  let timeZone = current.timeZone;
  if (input.timeZone !== undefined) {
    if (input.timeZone === null || input.timeZone === "") timeZone = null;
    else if (typeof input.timeZone !== "string" || !isValidTimeZone(input.timeZone))
      return bad("timeZone", "Choose a time zone from the list.");
    else timeZone = input.timeZone;
  }

  const next: GeneralSettings = { siteName, tagline, timeZone };
  await runner.transaction(async (tx) => {
    await upsert(tx, siteId, "title", next.siteName);
    await upsert(tx, siteId, "tagline", next.tagline);
    if (next.timeZone === null)
      await tx.all(`delete from "settings" where "site_id" = ? and "key" = 'timezone'`, [siteId]);
    else await upsert(tx, siteId, "timezone", next.timeZone);
    await tx.all(`update "sites" set "name" = ?, "updated_at" = ? where "id" = ?`, [
      next.siteName,
      new Date(),
      siteId,
    ]);
  });
  return { ok: true, settings: next };
}
