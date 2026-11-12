// The queries behind both data modules (server and export). No caching here.
import { enhanceImages } from "@oks-page/core";
import { getRunner, getSiteId } from "../db";
import { mediaContext } from "../uploads";
import type { EntryView } from "./types";

/** "/" is the entry with the slug "home"; other paths use the path without the leading slash. */
export const slugOf = (path: string[] | undefined) =>
  path && path.length > 0 ? path.join("/") : "home";

export async function loadPublishedEntry(slug: string): Promise<EntryView | null> {
  const siteId = await getSiteId();
  const rows = await getRunner().all(
    `select "id", "title", "slug", "type_key", "html", "plain_text", "updated_at" from "entries"
      where "site_id" = ? and "slug" = ? and "status" = 'published' and "locale" = ''
      order by case "type_key" when 'page' then 0 else 1 end limit 1`,
    [siteId, slug],
  );
  const r = rows[0];
  if (!r) return null;
  const updated = r["updated_at"];
  return {
    id: String(r["id"]),
    title: String(r["title"]),
    slug: String(r["slug"]),
    type: String(r["type_key"]),
    html: await enhanceImages(getRunner(), siteId, String(r["html"]), mediaContext().storage),
    plainText: String(r["plain_text"]),
    updatedAt: updated instanceof Date ? updated.getTime() : Number(updated),
  };
}

/** The cheap question the proxy asks on every request: is there a published entry at this address? Which one? */
export async function findPublished(slug: string): Promise<{ id: string; type: string } | null> {
  const siteId = await getSiteId();
  const rows = await getRunner().all(
    `select "id", "type_key" from "entries" where "site_id" = ? and "slug" = ? and "status" = 'published' and "locale" = '' limit 1`,
    [siteId, slug],
  );
  const r = rows[0];
  return r ? { id: String(r["id"]), type: String(r["type_key"]) } : null;
}

/** Every published address, for the export build (static mode), which makes one file per page. */
export async function listPublishedSlugs(): Promise<string[]> {
  const siteId = await getSiteId();
  const rows = await getRunner().all(
    `select "slug" from "entries" where "site_id" = ? and "status" = 'published' and "locale" = '' order by "slug"`,
    [siteId],
  );
  return rows.map((r) => String(r["slug"]));
}
