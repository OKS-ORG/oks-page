// Previews (spec 03, "Preview"; spec 08, section 12). An editor opens a draft on the real site, and can make a signed link
// that expires, for someone without an account (a client, a colleague). The link is the entry's id, an expiry time and a
// signature made with the site's secret, so it cannot be made up, cannot be moved to another entry and stops working
// at its time. It shows the last saved version, never a version in the shared cache.
import type { SqlRunner } from "@oks-page/db";
import { createHmac, timingSafeEqual } from "node:crypto";
import { chosenLayout } from "./theme-layouts.js";

export const PREVIEW_DEFAULT_DAYS = 7;
export const PREVIEW_MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const sign = (secret: string, id: string, expires: number): string =>
  createHmac("sha256", secret).update(`oks-preview:${id}:${expires}`).digest("base64url");

/** A link token for one entry: "<expiry in milliseconds>.<signature>". */
export function makePreviewToken(secret: string, id: string, expiresAt: number): string {
  return `${Math.floor(expiresAt)}.${sign(secret, id, Math.floor(expiresAt))}`;
}

/** The expiry time for a link made now that lasts this many days (1 to 30). */
export function previewExpiry(now: number, days: number = PREVIEW_DEFAULT_DAYS): number | null {
  if (!Number.isInteger(days) || days < 1 || days > PREVIEW_MAX_DAYS) return null;
  return now + days * DAY_MS;
}

/**
 * True when the token was made for this entry with this secret and has not expired. Any other answer is false: a wrong
 * entry, a changed expiry, a changed signature, a broken token, a token from another site's secret, or one that is
 * further away than the longest link we make (so an old, leaked secret cannot make links that never end).
 */
export function checkPreviewToken(
  secret: string,
  id: string,
  token: string | null | undefined,
  now: number,
): boolean {
  if (!secret || typeof token !== "string") return false;
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const expires = Number(match[1]);
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + PREVIEW_MAX_DAYS * DAY_MS)
    return false;
  const wanted = Buffer.from(sign(secret, id, expires));
  const given = Buffer.from(match[2]!);
  return wanted.length === given.length && timingSafeEqual(wanted, given);
}

export interface PreviewEntry {
  id: string;
  title: string;
  slug: string;
  type: string;
  status: string;
  html: string;
  updatedAt: number;
  /** The layout the entry chose in its settings ("" for its usual one). */
  layout: string;
}

/** The saved version of an entry in any state except the trash, or null. Never cached: a draft must not be shared. */
export async function loadPreviewEntry(
  runner: SqlRunner,
  siteId: string,
  id: string,
): Promise<PreviewEntry | null> {
  const rows = await runner.all(
    `select "id", "title", "slug", "type_key", "status", "html", "updated_at", "meta" from "entries"
      where "id" = ? and "site_id" = ? and "status" <> 'trash'`,
    [id, siteId],
  );
  const r = rows[0];
  if (!r) return null;
  const updated = r["updated_at"];
  return {
    id: String(r["id"]),
    title: String(r["title"]),
    slug: String(r["slug"]),
    type: String(r["type_key"]),
    status: String(r["status"]),
    html: String(r["html"]),
    updatedAt: updated instanceof Date ? updated.getTime() : Number(updated),
    layout: chosenLayout(r["meta"]),
  };
}
