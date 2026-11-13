// The queries behind both data modules (server and export). No caching here.
import {
  enhanceImages,
  excerptOf,
  firstImageOf,
  loadGeneralSettings,
  loadPublicMenu,
  loadThemeCss,
  readEntrySeo,
  type PublicMenuItem,
} from "@oks-page/core";
import { getRunner, getSiteId } from "../db";
import { mediaContext } from "../uploads";
import type { EntryView, SiteInfo, TermArchive } from "./types";

/** The CSS of the owner's look (colors and fonts); empty while the site has the built-in look. */
export async function loadThemeCssText(): Promise<string> {
  return loadThemeCss(getRunner(), await getSiteId());
}

/** The site's name and tagline (Settings, General). */
export async function loadSiteInfo(): Promise<SiteInfo> {
  const general = await loadGeneralSettings(getRunner(), await getSiteId());
  return { siteName: general.siteName, tagline: general.tagline };
}

/**
 * "/" is the entry with the slug "home"; other paths use the path without the leading slash. Addresses may hold letters
 * of any script, so the path is read in the composed Unicode form (NFC) that addresses are stored in: a browser or a
 * keyboard may send the same word in the decomposed form. A "%" can never be in an address, so a path that still has
 * one is percent-encoded and is decoded first.
 */
export const slugOf = (path: string[] | undefined) => {
  if (!path || path.length === 0) return "home";
  const joined = path.join("/");
  let decoded = joined;
  if (joined.includes("%"))
    try {
      decoded = decodeURIComponent(joined);
    } catch {
      decoded = joined; // not valid encoding: it will not be found, which is the right answer
    }
  return decoded.normalize("NFC");
};

export async function loadPublishedEntry(slug: string): Promise<EntryView | null> {
  const siteId = await getSiteId();
  const rows = await getRunner().all(
    `select e."id", e."title", e."slug", e."type_key", e."html", e."plain_text", e."seo", e."published_at", e."updated_at", u."name" as "author"
       from "entries" e left join "users" u on u."id" = e."author_id"
      where e."site_id" = ? and e."slug" = ? and e."status" = 'published' and e."locale" = ''
      order by case e."type_key" when 'page' then 0 else 1 end limit 1`,
    [siteId, slug],
  );
  const r = rows[0];
  if (!r) return null;
  const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
  const seo = readEntrySeo(r["seo"]);
  const written = String(r["html"]);
  const plain = String(r["plain_text"]);
  return {
    id: String(r["id"]),
    title: String(r["title"]),
    slug: String(r["slug"]),
    type: String(r["type_key"]),
    html: await enhanceImages(getRunner(), siteId, written, mediaContext().storage),
    plainText: plain,
    updatedAt: ms(r["updated_at"]),
    publishedAt: r["published_at"] == null ? ms(r["updated_at"]) : ms(r["published_at"]),
    authorName: r["author"] == null ? "" : String(r["author"]),
    description: seo.description || excerptOf(plain),
    noindex: seo.noindex,
    image: firstImageOf(written),
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

/** Splits an address like "category/travel" into the list and the term's address, or null if it is not one. */
export function archiveParts(slug: string): { kind: "category" | "tag"; slug: string } | null {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[1]) return null;
  const kind = parts[0] === "category" ? "category" : parts[0] === "tag" ? "tag" : null;
  return kind ? { kind, slug: parts[1] } : null;
}

/** The cheap question the proxy asks for an address that is not an entry: is it the archive of a real term? */
export async function findTermArchive(slug: string): Promise<{ id: string } | null> {
  const parts = archiveParts(slug);
  if (!parts) return null;
  const siteId = await getSiteId();
  const rows = await getRunner().all(
    `select t."id" from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
      where x."site_id" = ? and x."key" = ? and t."slug" = ? limit 1`,
    [siteId, parts.kind, parts.slug],
  );
  return rows[0] ? { id: String(rows[0]["id"]) } : null;
}

const MOST_POSTS = 100;

/** An archive with its newest published posts, or null when there is no such term. */
export async function loadTermArchive(slug: string): Promise<TermArchive | null> {
  const parts = archiveParts(slug);
  if (!parts) return null;
  const siteId = await getSiteId();
  const runner = getRunner();
  const found = await runner.all(
    `select t."id", t."name", t."slug", t."description" from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
      where x."site_id" = ? and x."key" = ? and t."slug" = ? limit 1`,
    [siteId, parts.kind, parts.slug],
  );
  const term = found[0];
  if (!term) return null;
  const id = String(term["id"]);
  // A category's archive also holds the posts of the categories under it.
  const ids = [id];
  if (parts.kind === "category")
    for (let from = [id]; from.length > 0;) {
      const marks = from.map(() => "?").join(", ");
      const kids = await runner.all(
        `select "id" from "terms" where "parent_id" in (${marks})`,
        from,
      );
      from = kids.map((k) => String(k["id"])).filter((k) => !ids.includes(k));
      ids.push(...from);
    }
  const marks = ids.map(() => "?").join(", ");
  const rows = await runner.all(
    `select distinct e."id", e."title", e."slug", e."published_at" from "entries" e
       join "entry_terms" et on et."entry_id" = e."id"
      where e."site_id" = ? and e."status" = 'published' and e."locale" = '' and e."type_key" = 'post'
        and et."term_id" in (${marks})
      order by e."published_at" desc, e."id" limit ${MOST_POSTS + 1}`,
    [siteId, ...ids],
  );
  const time = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
  return {
    id,
    kind: parts.kind,
    name: String(term["name"]),
    slug: String(term["slug"]),
    description: String(term["description"]),
    posts: rows.slice(0, MOST_POSTS).map((r) => ({
      title: String(r["title"]),
      slug: String(r["slug"]),
      publishedAt: time(r["published_at"]),
    })),
    more: rows.length > MOST_POSTS,
  };
}

/** The header ("primary") or footer ("footer") menu as visitors see it. */
export async function loadSiteMenu(place: string): Promise<PublicMenuItem[]> {
  return loadPublicMenu(getRunner(), await getSiteId(), place);
}

/** Every archive address, for the export build. */
export async function listArchiveSlugs(): Promise<string[]> {
  const siteId = await getSiteId();
  const rows = await getRunner().all(
    `select x."key", t."slug" from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
      where x."site_id" = ? and x."key" in ('category', 'tag') order by x."key", t."slug"`,
    [siteId],
  );
  return rows.map((r) => `${String(r["key"])}/${String(r["slug"])}`);
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
