// The sitemap and robots.txt (spec 08, section 8). The sitemap lists what search engines may index: published entries
// that are not set to `noindex`, and the category and tag pages that have posts. `robots.txt` lists the sitemap and keeps
// crawlers out of the admin, the API and the search page; it never blocks CSS, scripts or images.
import type { SqlRunner } from "@oks-page/db";
import { pathOfSlug } from "./redirects.js";

/** The most addresses in one sitemap file (the limit of the sitemap standard). */
export const SITEMAP_MAX_URLS = 50_000;

export interface SitemapUrl {
  /** The address path ("/", "/about", "/blog/hello", "/category/news"). */
  path: string;
  /** Milliseconds: when it last changed. */
  lastModified: number;
}

const toNumber = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

const asObject = (raw: unknown): Record<string, unknown> => {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
};

/**
 * Every address that belongs in the sitemap, in address order: published entries (not `noindex`), and the category and
 * tag pages that hold at least one such post, with the categories above them (their page lists the posts below).
 */
export async function loadSitemapUrls(runner: SqlRunner, siteId: string): Promise<SitemapUrl[]> {
  const entries = await runner.all(
    `select "id", "type_key", "slug", "updated_at", "seo" from "entries"
      where "site_id" = ? and "status" = 'published' and "locale" = '' order by "slug" limit ${SITEMAP_MAX_URLS}`,
    [siteId],
  );
  const urls: SitemapUrl[] = [];
  const ok = new Map<string, number>();
  for (const e of entries) {
    if (asObject(e["seo"])["noindex"] === true) continue;
    const updated = toNumber(e["updated_at"]);
    ok.set(String(e["id"]), updated);
    urls.push({ path: pathOfSlug(String(e["slug"])), lastModified: updated });
  }
  // Category and tag pages: the newest change among their posts.
  const links = await runner.all(
    `select et."entry_id", t."id" as "term_id", t."slug", t."parent_id", x."key"
       from "entry_terms" et join "terms" t on t."id" = et."term_id" join "taxonomies" x on x."id" = t."taxonomy_id"
      where x."site_id" = ? and x."key" in ('category', 'tag')`,
    [siteId],
  );
  const all = await runner.all(
    `select t."id", t."slug", t."parent_id", x."key" from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
      where x."site_id" = ? and x."key" in ('category', 'tag')`,
    [siteId],
  );
  const info = new Map(
    all.map((t) => [
      String(t["id"]),
      {
        path: `/${String(t["key"])}/${String(t["slug"])}`,
        parent: t["parent_id"] == null ? null : String(t["parent_id"]),
      },
    ]),
  );
  const latest = new Map<string, number>();
  for (const l of links) {
    const updated = ok.get(String(l["entry_id"]));
    if (updated === undefined) continue;
    for (let at: string | null = String(l["term_id"]); at; at = info.get(at)?.parent ?? null)
      latest.set(at, Math.max(latest.get(at) ?? 0, updated));
  }
  for (const [id, lastModified] of latest) {
    const term = info.get(id);
    if (term) urls.push({ path: term.path, lastModified });
  }
  return urls
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, SITEMAP_MAX_URLS);
}

const escapeXml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** The sitemap file. Addresses are made absolute and percent-encoded (Hindi and accented addresses stay valid). */
export function buildSitemapXml(origin: string, urls: SitemapUrl[]): string {
  const items = urls
    .map(
      (u) =>
        `<url><loc>${escapeXml(new URL(u.path, origin).href)}</loc><lastmod>${new Date(u.lastModified).toISOString()}</lastmod></url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}${items ? "\n" : ""}</urlset>\n`;
}

/**
 * robots.txt. Normally: everyone may crawl except the admin, the API and the search page, and the sitemap is listed. When
 * the owner asks search engines to stay away, everything is closed and no sitemap is listed.
 */
export function buildRobotsTxt(origin: string, discourage: boolean): string {
  if (discourage) return "User-agent: *\nDisallow: /\n";
  return [
    "User-agent: *",
    "Disallow: /admin",
    "Disallow: /api/",
    "Disallow: /search",
    "",
    `Sitemap: ${new URL("/sitemap.xml", origin).href}`,
    "",
  ].join("\n");
}
