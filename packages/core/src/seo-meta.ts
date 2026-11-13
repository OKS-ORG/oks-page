// What a page tells search engines and social sites about itself (spec 08, sections 9, 10 and 12): a description, a picture,
// structured data (JSON-LD), and the feeds. These are small pure functions, tested without a database.

/** A short description made from the text: whitespace collapsed, cut at a word, "…" when cut. Counted in characters. */
export function excerptOf(text: string, max = 155): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  // Cut at the last space when that keeps most of the text; a text with no spaces (Chinese, a long URL) is cut as it is.
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return kept.replace(/[\s,.;:!?-]+$/u, "") + "…";
}

/** The address of the first picture in the written HTML, or null. */
export function firstImageOf(html: string): string | null {
  const match = /<img\b[^>]*?\bsrc="([^"]+)"/i.exec(html);
  if (!match) return null;
  return match[1]!.replace(/&amp;/g, "&");
}

/**
 * JSON for a `<script type="application/ld+json">` tag. A title can end the tag early ("</script>"), so `<`, `>`, `&` and the
 * two line separators are written as `\u` escapes: the JSON means the same and can never close the tag. One function does
 * this; no other code may write JSON into a script tag (spec 08, section 10).
 */
const BREAKERS = new RegExp(
  `[<>&${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  "g",
);

export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(
    BREAKERS,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const absolute = (origin: string, path: string) => new URL(path, origin).href;

export interface PostLd {
  origin: string;
  path: string;
  title: string;
  description: string;
  image: string | null;
  publishedAt: number;
  modifiedAt: number;
  authorName: string;
  siteName: string;
}

/** A blog post as structured data (schema.org BlogPosting) with its breadcrumb. */
export function postStructuredData(p: PostLd): unknown[] {
  const url = absolute(p.origin, p.path);
  return [
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: p.title,
      description: p.description,
      url,
      mainEntityOfPage: url,
      datePublished: new Date(p.publishedAt).toISOString(),
      dateModified: new Date(p.modifiedAt).toISOString(),
      ...(p.authorName ? { author: { "@type": "Person", name: p.authorName } } : {}),
      ...(p.image ? { image: absolute(p.origin, p.image) } : {}),
      publisher: { "@type": "Organization", name: p.siteName },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: p.siteName, item: absolute(p.origin, "/") },
        { "@type": "ListItem", position: 2, name: p.title, item: url },
      ],
    },
  ];
}

/** The site itself as structured data (schema.org WebSite), with the search box the site has. */
export function websiteStructuredData(w: {
  origin: string;
  name: string;
  description: string;
}): unknown {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: w.name,
    url: absolute(w.origin, "/"),
    ...(w.description ? { description: w.description } : {}),
    potentialAction: {
      "@type": "SearchAction",
      target: `${absolute(w.origin, "/search")}?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  };
}

// ---- feeds -------------------------------------------------------------------------------------------------------------

export interface FeedItem {
  title: string;
  /** The address path ("/blog/hello"). */
  path: string;
  /** The page's written HTML. */
  html: string;
  excerpt: string;
  publishedAt: number;
  modifiedAt: number;
  authorName: string;
}

export interface FeedInfo {
  origin: string;
  siteName: string;
  /** What the feed is about: the tagline, or "Category: News". */
  description: string;
  /** The address path of the page the feed belongs to ("/" or "/category/news"). */
  homePath: string;
  /** The address path of the feed itself. */
  selfPath: string;
  title: string;
}

const escapeXml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** Pictures and links in the written HTML point at "/uploads/..." and "/blog/..."; a feed is read elsewhere, so they get the site's address. */
export function absolutizeHtml(html: string, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return html.replace(/\b(src|href)="\/(?!\/)/g, `$1="${base}/`);
}

/** An RSS 2.0 feed (with the full text in `content:encoded`). */
export function buildRss(info: FeedInfo, items: FeedItem[]): string {
  const last = items.reduce((m, i) => Math.max(m, i.modifiedAt), 0);
  const body = items
    .map((i) => {
      const link = absolute(info.origin, i.path);
      return [
        "<item>",
        `<title>${escapeXml(i.title)}</title>`,
        `<link>${escapeXml(link)}</link>`,
        `<guid isPermaLink="true">${escapeXml(link)}</guid>`,
        `<pubDate>${new Date(i.publishedAt).toUTCString()}</pubDate>`,
        ...(i.authorName ? [`<dc:creator>${escapeXml(i.authorName)}</dc:creator>`] : []),
        `<description>${escapeXml(i.excerpt)}</description>`,
        `<content:encoded>${escapeXml(absolutizeHtml(i.html, info.origin))}</content:encoded>`,
        "</item>",
      ].join("");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>${escapeXml(info.title)}</title>
<link>${escapeXml(absolute(info.origin, info.homePath))}</link>
<description>${escapeXml(info.description || info.siteName)}</description>
<atom:link href="${escapeXml(absolute(info.origin, info.selfPath))}" rel="self" type="application/rss+xml"/>
${last ? `<lastBuildDate>${new Date(last).toUTCString()}</lastBuildDate>\n` : ""}${body}${body ? "\n" : ""}</channel>
</rss>
`;
}

/** An Atom 1.0 feed. */
export function buildAtom(info: FeedInfo, items: FeedItem[]): string {
  const last = items.reduce((m, i) => Math.max(m, i.modifiedAt), 0);
  const body = items
    .map((i) => {
      const link = absolute(info.origin, i.path);
      return [
        "<entry>",
        `<title>${escapeXml(i.title)}</title>`,
        `<link href="${escapeXml(link)}"/>`,
        `<id>${escapeXml(link)}</id>`,
        `<published>${new Date(i.publishedAt).toISOString()}</published>`,
        `<updated>${new Date(i.modifiedAt).toISOString()}</updated>`,
        ...(i.authorName ? [`<author><name>${escapeXml(i.authorName)}</name></author>`] : []),
        `<summary>${escapeXml(i.excerpt)}</summary>`,
        `<content type="html">${escapeXml(absolutizeHtml(i.html, info.origin))}</content>`,
        "</entry>",
      ].join("");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${escapeXml(info.title)}</title>
<subtitle>${escapeXml(info.description || info.siteName)}</subtitle>
<link href="${escapeXml(absolute(info.origin, info.homePath))}"/>
<link href="${escapeXml(absolute(info.origin, info.selfPath))}" rel="self" type="application/atom+xml"/>
<id>${escapeXml(absolute(info.origin, info.homePath))}</id>
<updated>${new Date(last || 0).toISOString()}</updated>
${body}${body ? "\n" : ""}</feed>
`;
}

// ---- what a person writes in the SEO box -----------------------------------------------------------------------------------

export const SEO_DESCRIPTION_MAX = 300;

export interface EntrySeo {
  /** The text for search results and link previews; empty means one is made from the page's text. */
  description: string;
  /** True: ask search engines not to list this page (it also leaves the sitemap, the search and the feeds). */
  noindex: boolean;
}

/** What is meant by a saved `seo` value (the entry's `seo` JSON column): damaged values mean no description and indexed. */
export function readEntrySeo(raw: unknown): EntrySeo {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  const saved = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const description = typeof saved["description"] === "string" ? saved["description"].trim() : "";
  return {
    description: Array.from(description).length <= SEO_DESCRIPTION_MAX ? description : "",
    noindex: saved["noindex"] === true,
  };
}
