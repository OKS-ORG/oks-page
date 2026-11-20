// The queries behind both data modules (server and export). No caching here.
import {
  approvedComments,
  directionOf,
  pageCssOfBody,
  pageStyleUrl,
  loadReadingRoutes,
  loadScreenSizes,
  loadSiteIcon,
  loadSiteLanguage,
  type ReadingRoutes,
  chosenLayout,
  enhanceImages,
  excerptOf,
  firstImageOf,
  loadGeneralSettings,
  loadPublicMenu,
  loadActiveThemeCssKey,
  loadThemeVersion,
  loadActiveThemeLayouts,
  loadFeedPosts,
  type FeedItem,
  type ThemeLayouts,
  loadThemeStyles,
  stylesToCss,
  readEntrySeo,
  type PublicMenuItem,
} from "@oks-page/core";
import { getRunner, getSiteId } from "../db";
import { mediaContext } from "../uploads";
import { pageCount } from "../paging";
import { styleFileUrl } from "../site-style";
import type { EntryView, Look, PostsPage, SiteInfo, TermArchive, TypeList } from "./types";

/**
 * The look: the CSS file of the theme in use, the owner's CSS for the colors and fonts (it comes after the theme's, so
 * the owner's choices win), and the logo (its address and size) when one is chosen. With `themeId` it is the look the
 * site would have with that installed theme (the preview of a theme that is not in use).
 */
export async function loadLook(themeId?: string): Promise<Look> {
  const runner = getRunner();
  const siteId = await getSiteId();
  const styles = await loadThemeStyles(runner, siteId);
  let logo: Look["logo"] = null;
  if (styles.logoMediaId) {
    const rows = await runner.all(
      `select "storage_key", "width", "height", "alt" from "media"
        where "site_id" = ? and "id" = ? and "status" = 'ready'`,
      [siteId, styles.logoMediaId],
    );
    const row = rows[0];
    if (row) {
      const name = (await loadSiteInfo()).siteName;
      logo = {
        url: mediaContext().storage.publicUrl(String(row["storage_key"])),
        width: row["width"] == null ? null : Number(row["width"]),
        height: row["height"] == null ? null : Number(row["height"]),
        alt: String(row["alt"]) || name,
      };
    }
  }
  const themeCssKey = themeId
    ? ((await loadThemeVersion(runner, siteId, themeId))?.version.cssKey ?? null)
    : await loadActiveThemeCssKey(runner, siteId);
  const css = stylesToCss(styles);
  return {
    themeCssUrl: themeCssKey ? mediaContext().storage.publicUrl(themeCssKey) : null,
    css,
    cssUrl: css ? styleFileUrl(css) : null,
    styleFiles: true,
    logo,
    colorMode: styles.colorMode,
    modeSwitch: styles.modeSwitch,
  };
}

/** The layouts of the theme in use, ready to draw, or null (pages are then drawn the built-in way). */
export async function loadThemeLayouts(): Promise<ThemeLayouts | null> {
  return loadActiveThemeLayouts(getRunner(), await getSiteId());
}

/** The newest published posts (at most 20), for a theme's list of latest posts. */
export async function loadLatestPosts(): Promise<FeedItem[]> {
  return (await loadFeedPosts(getRunner(), await getSiteId(), null))?.items ?? [];
}

/** The site's name and tagline (Settings, General). */
export async function loadSiteInfo(): Promise<SiteInfo> {
  const siteId = await getSiteId();
  const general = await loadGeneralSettings(getRunner(), siteId);
  const language = await loadSiteLanguage(getRunner(), siteId);
  const icon = await loadSiteIcon(getRunner(), siteId);
  return {
    siteName: general.siteName,
    tagline: general.tagline,
    lang: language.tag,
    dir: directionOf(language),
    icon: icon ? { url: mediaContext().storage.publicUrl(icon.key), type: icon.mime } : null,
  };
}

/** Where the home page and the posts page are (Settings > Reading). */
export async function loadReading(): Promise<ReadingRoutes> {
  return loadReadingRoutes(getRunner(), await getSiteId());
}

/** The ids of published posts that ask to stay out of lists (a small set: the SEO box's "do not list this page"). */
async function unlistedPostIds(siteId: string, typeKey = "post"): Promise<string[]> {
  // The value is JSON in both databases; casting it to text lets one query read it in either (PostgreSQL's jsonb writes
  // `"noindex": true`, SQLite keeps what was saved).
  const rows = await getRunner().all(
    `select "id", "seo" from "entries"
      where "site_id" = ? and "type_key" = ? and "status" = 'published' and "locale" = ''
        and cast("seo" as text) like '%"noindex"%'`,
    [siteId, typeKey],
  );
  return rows.filter((r) => readEntrySeo(r["seo"]).noindex).map((r) => String(r["id"]));
}

/**
 * One page of the published posts that may be listed (not those set to stay out of lists), newest first, with how many
 * pages there are. Page 1 is the newest `perPage` posts.
 */
export async function loadPostsPage(perPage: number, page: number): Promise<PostsPage> {
  const siteId = await getSiteId();
  const runner = getRunner();
  const hidden = await unlistedPostIds(siteId);
  const where = `"site_id" = ? and "type_key" = 'post' and "status" = 'published' and "locale" = ''${
    hidden.length > 0 ? ` and "id" not in (${hidden.map(() => "?").join(", ")})` : ""
  }`;
  const args = [siteId, ...hidden];
  const total = Number(
    (await runner.all(`select count(*) as "n" from "entries" where ${where}`, args))[0]?.["n"] ?? 0,
  );
  const rows = await runner.all(
    `select "title", "slug", "plain_text", "seo", "published_at" from "entries"
      where ${where} order by "published_at" desc, "id" desc limit ? offset ?`,
    [...args, perPage, (Math.max(1, page) - 1) * perPage],
  );
  const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
  return {
    page,
    pages: pageCount(total, perPage),
    total,
    posts: rows.map((r) => {
      const seo = readEntrySeo(r["seo"]);
      return {
        title: String(r["title"]),
        slug: String(r["slug"]),
        publishedAt: ms(r["published_at"]),
        excerpt: seo.description || excerptOf(String(r["plain_text"])),
      };
    }),
  };
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

function readBody(raw: unknown): unknown {
  if (raw == null) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/** The approved comments of a post, and whether comments are on. */
export async function loadComments(entryId: string) {
  return approvedComments(getRunner(), await getSiteId(), entryId);
}

export async function loadPublishedEntry(slug: string): Promise<EntryView | null> {
  const siteId = await getSiteId();
  const rows = await getRunner().all(
    `select e."id", e."title", e."slug", e."type_key", e."html", e."body", e."plain_text", e."seo", e."meta", e."published_at", e."updated_at", u."name" as "author"
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
  // The responsive styles of the blocks come as a file the page links to (spec 06, 4.3).
  const pageCss = pageCssOfBody(readBody(r["body"]), await loadScreenSizes(getRunner(), siteId));
  const styleUrl = pageStyleUrl(String(r["id"]), pageCss);
  const link = styleUrl ? `<link rel="stylesheet" href="${styleUrl}">` : "";
  return {
    id: String(r["id"]),
    title: String(r["title"]),
    slug: String(r["slug"]),
    type: String(r["type_key"]),
    html: link + (await enhanceImages(getRunner(), siteId, written, mediaContext().storage)),
    pageStyle: { css: pageCss, link },
    plainText: plain,
    updatedAt: ms(r["updated_at"]),
    publishedAt: r["published_at"] == null ? ms(r["updated_at"]) : ms(r["published_at"]),
    authorName: r["author"] == null ? "" : String(r["author"]),
    description: seo.description || excerptOf(plain),
    noindex: seo.noindex,
    image: firstImageOf(written),
    layout: chosenLayout(r["meta"]),
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

/**
 * What the request proxy needs to know about an address, in one round trip to the database: the published entry at it,
 * and the redirect from it (spec 08, section 7). On PostgreSQL the first query of a request pays most of the wait, so one
 * query instead of two keeps a missing address as fast as a found one.
 */
export async function findAddress(
  slug: string,
  path: string,
): Promise<{
  entry: { id: string; type: string } | null;
  redirect: { id: string; to: string; status: number } | null;
  /** The custom type whose list is at this address ("shop" for the prefix "shop/"). */
  typeList: { key: string } | null;
}> {
  const siteId = await getSiteId();
  const rows = await getRunner().all(
    `select * from (select 'entry' as "kind", "id", "type_key" as "detail", 0 as "code" from "entries"
        where "site_id" = ? and "slug" = ? and "status" = 'published' and "locale" = '' limit 1) as e
     union all
     select * from (select 'redirect' as "kind", "id", "to_path" as "detail", "status_code" as "code" from "redirects"
        where "site_id" = ? and "from_path" = ? limit 1) as r
     union all
     select * from (select 'list' as "kind", "id", "key" as "detail", 0 as "code" from "content_types"
        where "site_id" = ? and "url_rule" = ? and "key" not in ('page', 'post') limit 1) as l`,
    [siteId, slug, siteId, path, siteId, `/${slug}/{slug}`],
  );
  const list = rows.find((r) => r["kind"] === "list");
  const entry = rows.find((r) => r["kind"] === "entry");
  const redirect = rows.find((r) => r["kind"] === "redirect");
  return {
    typeList: list ? { key: String(list["detail"]) } : null,
    entry: entry ? { id: String(entry["id"]), type: String(entry["detail"]) } : null,
    redirect: redirect
      ? {
          id: String(redirect["id"]),
          to: String(redirect["detail"]),
          status: Number(redirect["code"]),
        }
      : null,
  };
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

/** The ids of a term and, for a category, of the categories under it: an archive holds the posts of all of them. */
async function termWithChildren(kind: "category" | "tag", id: string): Promise<string[]> {
  const ids = [id];
  if (kind === "category")
    for (let from = [id]; from.length > 0;) {
      const marks = from.map(() => "?").join(", ");
      const kids = await getRunner().all(
        `select "id" from "terms" where "parent_id" in (${marks})`,
        from,
      );
      from = kids.map((k) => String(k["id"])).filter((k) => !ids.includes(k));
      ids.push(...from);
    }
  return ids;
}

const POSTS_OF_TERMS = `from "entries" e join "entry_terms" et on et."entry_id" = e."id"
      where e."site_id" = ? and e."status" = 'published' and e."locale" = '' and e."type_key" = 'post'`;

/** How many published posts an archive holds. */
async function countTermPosts(siteId: string, ids: string[]): Promise<number> {
  const marks = ids.map(() => "?").join(", ");
  const rows = await getRunner().all(
    `select count(distinct e."id") as "n" ${POSTS_OF_TERMS} and et."term_id" in (${marks})`,
    [siteId, ...ids],
  );
  return Number(rows[0]?.["n"] ?? 0);
}

/** One page of an archive with its posts (newest first), or null when there is no such term. */
export async function loadTermArchive(
  slug: string,
  perPage = 10,
  page = 1,
): Promise<TermArchive | null> {
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
  const ids = await termWithChildren(parts.kind, id);
  const marks = ids.map(() => "?").join(", ");
  const total = await countTermPosts(siteId, ids);
  const rows = await runner.all(
    `select distinct e."id", e."title", e."slug", e."published_at" ${POSTS_OF_TERMS}
        and et."term_id" in (${marks})
      order by e."published_at" desc, e."id" limit ? offset ?`,
    [siteId, ...ids, perPage, (Math.max(1, page) - 1) * perPage],
  );
  const time = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
  return {
    id,
    kind: parts.kind,
    name: String(term["name"]),
    slug: String(term["slug"]),
    description: String(term["description"]),
    posts: rows.map((r) => ({
      title: String(r["title"]),
      slug: String(r["slug"]),
      publishedAt: time(r["published_at"]),
    })),
    page,
    pages: pageCount(total, perPage),
    total,
  };
}

/**
 * How many pages the list at an address has, or null when the address is not a list: the home page when it shows the newest
 * posts, the posts page, or the archive of a category or tag. The request proxy asks this for "<list>/page/<n>", so an
 * address past the last page is a real 404. `archiveId` is the term's id for an archive (for its cache tag).
 */
export async function listPages(
  base: string,
  perPage: number,
  reading: ReadingRoutes,
): Promise<{ pages: number; archiveId: string | null; typeKey?: string } | null> {
  const siteId = await getSiteId();
  if (
    (base === "home" && reading.homeShows === "posts") ||
    (reading.postsSlug && base === reading.postsSlug)
  ) {
    const hidden = await unlistedPostIds(siteId);
    const marks = hidden.map(() => "?").join(", ");
    const rows = await getRunner().all(
      `select count(*) as "n" from "entries"
        where "site_id" = ? and "type_key" = 'post' and "status" = 'published' and "locale" = ''${
          hidden.length > 0 ? ` and "id" not in (${marks})` : ""
        }`,
      [siteId, ...hidden],
    );
    return { pages: pageCount(Number(rows[0]?.["n"] ?? 0), perPage), archiveId: null };
  }
  const parts = archiveParts(base);
  const term = parts ? await findTermArchive(base) : null;
  if (parts && term) {
    const total = await countTermPosts(siteId, await termWithChildren(parts.kind, term.id));
    return { pages: pageCount(total, perPage), archiveId: term.id };
  }
  const type = await findTypeList(base);
  if (!type) return null;
  const { total } = await typeListWhere(siteId, type.key);
  return { pages: pageCount(total, perPage), archiveId: null, typeKey: type.key };
}

/**
 * The custom type whose list is at this address: a type with the address prefix "shop/" lists its entries at "shop".
 * Page and Post are built in and have no list of their own here; a type with no prefix has no list address.
 */
export async function findTypeList(base: string): Promise<{ key: string; label: string } | null> {
  if (!base || base === "home") return null;
  const rows = await getRunner().all(
    `select "key", "label" from "content_types"
      where "site_id" = ? and "url_rule" = ? and "key" not in ('page', 'post') limit 1`,
    [await getSiteId(), `/${base}/{slug}`],
  );
  return rows[0] ? { key: String(rows[0]["key"]), label: String(rows[0]["label"]) } : null;
}

/** The test for the entries a type's list shows (published, not set to stay out of lists) and how many there are. */
async function typeListWhere(siteId: string, typeKey: string) {
  const hidden = await unlistedPostIds(siteId, typeKey);
  const where = `"site_id" = ? and "type_key" = ? and "status" = 'published' and "locale" = ''${
    hidden.length > 0 ? ` and "id" not in (${hidden.map(() => "?").join(", ")})` : ""
  }`;
  const args = [siteId, typeKey, ...hidden];
  const rows = await getRunner().all(`select count(*) as "n" from "entries" where ${where}`, args);
  return { where, args, total: Number(rows[0]?.["n"] ?? 0) };
}

/** One page of the list of a custom type (newest first), or null when no type has this address. */
export async function loadTypeList(base: string, perPage = 10, page = 1): Promise<TypeList | null> {
  const type = await findTypeList(base);
  if (!type) return null;
  const siteId = await getSiteId();
  const { where, args, total } = await typeListWhere(siteId, type.key);
  const rows = await getRunner().all(
    `select "title", "slug", "plain_text", "seo", "published_at" from "entries"
      where ${where} order by "published_at" desc, "id" desc limit ? offset ?`,
    [...args, perPage, (Math.max(1, page) - 1) * perPage],
  );
  const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
  return {
    key: type.key,
    label: type.label,
    base,
    page,
    pages: pageCount(total, perPage),
    total,
    posts: rows.map((r) => ({
      title: String(r["title"]),
      slug: String(r["slug"]),
      publishedAt: ms(r["published_at"]),
      excerpt: readEntrySeo(r["seo"]).description || excerptOf(String(r["plain_text"])),
    })),
  };
}

/** The address of every custom type's list (the types that have an address prefix), for the export build. */
export async function listTypeListSlugs(): Promise<string[]> {
  const rows = await getRunner().all(
    `select "url_rule" from "content_types"
      where "site_id" = ? and "key" not in ('page', 'post') order by "url_rule"`,
    [await getSiteId()],
  );
  const out: string[] = [];
  for (const r of rows) {
    const m = /^\/((?:[a-z0-9-]+\/)+)\{slug\}$/.exec(String(r["url_rule"]));
    if (m) out.push(m[1]!.slice(0, -1));
  }
  return out;
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
