// The SEO box of a page or post (spec 08, section 9) and the posts of a feed (section 12). A page's description and its
// "do not list this page" switch are kept in the entry's own `seo` value; the sitemap, the search and the feeds read them.
import type { SqlRunner } from "@oks-page/db";
import { loadForEdit, type Actor } from "./content.js";
import {
  SEO_DESCRIPTION_MAX,
  excerptOf,
  readEntrySeo,
  type EntrySeo,
  type FeedItem,
} from "./seo-meta.js";

export type EntrySeoResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: "forbidden" | "not_found" | "invalid"; message: string; field?: string };

const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const parseObject = (raw: unknown): Record<string, unknown> => {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

/** What the SEO box shows for an entry; only for someone who may edit it. */
export async function loadEntrySeo(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<EntrySeoResult<{ seo: EntrySeo }>> {
  const loaded = await loadForEdit(runner, actor, siteId, id);
  if (!loaded.ok)
    return {
      ok: false,
      code: loaded.code === "forbidden" ? "forbidden" : "not_found",
      message: loaded.message,
    };
  const rows = await runner.all(`select "seo" from "entries" where "id" = ? and "site_id" = ?`, [
    id,
    siteId,
  ]);
  return { ok: true, seo: readEntrySeo(rows[0]?.["seo"]) };
}

/**
 * Saves the description and the switch of an entry; other things kept in its `seo` value stay. Only people who may edit the
 * entry. The page's own text and revisions are not touched, but it counts as changed (the sitemap shows the new time).
 */
export async function setEntrySeo(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  input: { description?: unknown; noindex?: unknown },
  now: () => number = Date.now,
): Promise<EntrySeoResult<{ seo: EntrySeo; slug: string }>> {
  const loaded = await loadForEdit(runner, actor, siteId, id);
  if (!loaded.ok)
    return {
      ok: false,
      code: loaded.code === "forbidden" ? "forbidden" : "not_found",
      message: loaded.message,
    };
  const rows = await runner.all(
    `select "seo", "slug" from "entries" where "id" = ? and "site_id" = ?`,
    [id, siteId],
  );
  const stored = parseObject(rows[0]?.["seo"]);
  const current = readEntrySeo(stored);
  let description = current.description;
  if (input.description !== undefined) {
    if (typeof input.description !== "string")
      return {
        ok: false,
        code: "invalid",
        message: "The description was not understood.",
        field: "description",
      };
    description = input.description.trim();
    if (Array.from(description).length > SEO_DESCRIPTION_MAX)
      return {
        ok: false,
        code: "invalid",
        message: `The description can be at most ${SEO_DESCRIPTION_MAX} characters.`,
        field: "description",
      };
  }
  let noindex = current.noindex;
  if (input.noindex !== undefined) {
    if (typeof input.noindex !== "boolean")
      return {
        ok: false,
        code: "invalid",
        message: "The choice must be on or off.",
        field: "noindex",
      };
    noindex = input.noindex;
  }
  const next: Record<string, unknown> = { ...stored };
  if (description) next["description"] = description;
  else delete next["description"];
  if (noindex) next["noindex"] = true;
  else delete next["noindex"];
  await runner.all(
    `update "entries" set "seo" = ?, "updated_at" = ? where "id" = ? and "site_id" = ?`,
    [JSON.stringify(next), new Date(now()), id, siteId],
  );
  return { ok: true, seo: { description, noindex }, slug: String(rows[0]?.["slug"] ?? "") };
}

export interface FeedPosts {
  /** The category the feed is about, or null for the whole blog. */
  category: { name: string; slug: string } | null;
  items: FeedItem[];
}

const MOST_IN_FEED = 20;

/**
 * The newest published posts for a feed: the whole blog, or one category (with the categories under it). Posts set to
 * `noindex` are left out, as from the sitemap and the search. Null when the category does not exist.
 */
export async function loadFeedPosts(
  runner: SqlRunner,
  siteId: string,
  categorySlug: string | null,
  limit = MOST_IN_FEED,
): Promise<FeedPosts | null> {
  let category: FeedPosts["category"] = null;
  let ids: string[] = [];
  if (categorySlug !== null) {
    const found = await runner.all(
      `select t."id", t."name", t."slug" from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
        where x."site_id" = ? and x."key" = 'category' and t."slug" = ?`,
      [siteId, categorySlug],
    );
    if (!found[0]) return null;
    category = { name: String(found[0]["name"]), slug: String(found[0]["slug"]) };
    ids = [String(found[0]["id"])];
    for (let from = [...ids]; from.length > 0;) {
      const kids = await runner.all(
        `select "id" from "terms" where "parent_id" in (${from.map(() => "?").join(", ")})`,
        from,
      );
      from = kids.map((k) => String(k["id"])).filter((k) => !ids.includes(k));
      ids.push(...from);
    }
  }
  const rows = await runner.all(
    `select distinct e."id", e."title", e."slug", e."html", e."plain_text", e."seo", e."published_at", e."updated_at", u."name" as "author"
       from "entries" e left join "users" u on u."id" = e."author_id"
      ${ids.length > 0 ? `join "entry_terms" et on et."entry_id" = e."id"` : ""}
      where e."site_id" = ? and e."status" = 'published' and e."locale" = '' and e."type_key" = 'post'
      ${ids.length > 0 ? `and et."term_id" in (${ids.map(() => "?").join(", ")})` : ""}
      order by e."published_at" desc, e."id" limit ${limit * 4}`,
    [siteId, ...ids],
  );
  const items: FeedItem[] = [];
  for (const r of rows) {
    const seo = readEntrySeo(r["seo"]);
    if (seo.noindex) continue;
    items.push({
      title: String(r["title"]),
      path: `/${String(r["slug"])}`,
      html: String(r["html"]),
      excerpt: seo.description || excerptOf(String(r["plain_text"])),
      publishedAt: toMs(r["published_at"]),
      modifiedAt: toMs(r["updated_at"]),
      authorName: r["author"] == null ? "" : String(r["author"]),
    });
    if (items.length === limit) break;
  }
  return { category, items };
}
