// The admin's quick search (Ctrl+K): pages and posts by title. A person finds only what they may edit.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export interface AdminSearchHit {
  id: string;
  type: "page" | "post";
  title: string;
  status: string;
}

export const ADMIN_SEARCH_MIN = 2;
export const ADMIN_SEARCH_MAX = 100;
const SHOWN = 8;

/** Pages and posts whose title holds every word, newest first. Trash is left out. */
export async function searchAdminEntries(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  query: string,
): Promise<AdminSearchHit[]> {
  const words = query
    .trim()
    .slice(0, ADMIN_SEARCH_MAX)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  if (words.length === 0 || words.join(" ").length < ADMIN_SEARCH_MIN) return [];
  const escape = (w: string) => w.replace(/[\\%_]/g, (c) => "\\" + c);
  const rows = await runner.all(
    `select "id", "type_key", "title", "status", "author_id" from "entries"
      where "site_id" = ? and "type_key" in ('page', 'post') and "status" <> 'trash'
        ${words.map(() => `and lower("title") like ? escape '\\'`).join(" ")}
      order by "updated_at" desc, "id" limit 50`,
    [siteId, ...words.map((w) => `%${escape(w)}%`)],
  );
  const hits: AdminSearchHit[] = [];
  for (const r of rows) {
    const type = String(r["type_key"]) as "page" | "post";
    const mine = String(r["author_id"]) === actor.userId;
    if (!(actor.can("content.edit_any", type) || (mine && actor.can("content.edit_own", type))))
      continue;
    hits.push({
      id: String(r["id"]),
      type,
      title: String(r["title"]),
      status: String(r["status"]),
    });
    if (hits.length === SHOWN) break;
  }
  return hits;
}
