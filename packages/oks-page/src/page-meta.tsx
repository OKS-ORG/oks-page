// What every public page says about itself in its head and in its structured data: the title (`{title} – {site}`), a
// description, the canonical address, Open Graph and Twitter tags, `noindex` when the page asks for it, and JSON-LD. The
// server build and the export build use the same functions, so both write the same page. Feed links are only for the
// server build: a static export has no feeds.
import { excerptOf, jsonLd, postStructuredData, websiteStructuredData } from "@oks-page/core";
import type { Metadata } from "next";
import type { EntryView, SiteInfo, TermArchive } from "./data/types";
import { pagePath } from "./paging";
import { canonicalFor } from "./site-url";

const FEEDS = {
  "application/rss+xml": "/feed.xml",
  "application/atom+xml": "/atom.xml",
};

const origin = () => new URL(canonicalFor("home")).origin;
const absolute = (path: string) => new URL(path, origin()).href;

/** The page title: "Hello – My Site"; the front page is the site name and its tagline. */
export function titleOf(title: string, site: SiteInfo, isFront = false): string {
  if (isFront) return site.tagline ? `${site.siteName} – ${site.tagline}` : site.siteName;
  return `${title} – ${site.siteName}`;
}

/** The site icon for every public page (Settings > General). */
export const iconsOf = (site: SiteInfo): Metadata =>
  site.icon ? { icons: { icon: [{ url: site.icon.url, type: site.icon.type }] } } : {};

/** The list of newest posts at "/" or at the posts page's address (Settings > Reading). */
export function postsMetadata(
  title: string,
  slug: string,
  site: SiteInfo,
  isFront: boolean,
  page = 1,
): Metadata {
  // A later page is its own page: its own title and its own canonical address (not the first page's).
  if (page > 1)
    return {
      title: titleOf(`${title} – Page ${page}`, site, false),
      alternates: { canonical: canonicalFor(pagePath(slug, page).slice(1)), types: FEEDS },
      ...iconsOf(site),
    };
  return {
    title: titleOf(title, site, isFront),
    alternates: { canonical: isFront ? canonicalFor("home") : canonicalFor(slug), types: FEEDS },
    ...iconsOf(site),
  };
}

/** The list of a custom type at its own address ("shop"). */
export function typeListMetadata(
  list: { label: string; base: string },
  site: SiteInfo,
  page = 1,
): Metadata {
  return {
    title: titleOf(page > 1 ? `${list.label} – Page ${page}` : list.label, site, false),
    alternates: {
      canonical: canonicalFor(page > 1 ? pagePath(list.base, page).slice(1) : list.base),
    },
    ...iconsOf(site),
  };
}

export function entryMetadata(
  entry: EntryView,
  site: SiteInfo,
  options: { feeds: boolean; front?: boolean },
): Metadata {
  const isFront = options.front ?? entry.slug === "home";
  const title = titleOf(entry.title, site, isFront);
  const url = canonicalFor(isFront ? "home" : entry.slug);
  const image = entry.image ? absolute(entry.image) : null;
  return {
    ...iconsOf(site),
    title,
    description: entry.description,
    alternates: {
      canonical: url,
      ...(options.feeds ? { types: FEEDS } : {}),
    },
    ...(entry.noindex ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      type: entry.type === "post" ? "article" : "website",
      title,
      description: entry.description,
      url,
      siteName: site.siteName,
      ...(image ? { images: [{ url: image }] } : {}),
      ...(entry.type === "post"
        ? {
            publishedTime: new Date(entry.publishedAt).toISOString(),
            modifiedTime: new Date(entry.updatedAt).toISOString(),
            ...(entry.authorName ? { authors: [entry.authorName] } : {}),
          }
        : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description: entry.description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export function archiveMetadata(
  archive: TermArchive,
  slug: string,
  site: SiteInfo,
  options: { feeds: boolean },
  page = 1,
): Metadata {
  const label = `${archive.kind === "category" ? "Category" : "Tag"}: ${archive.name}`;
  const title = `${label}${page > 1 ? ` – Page ${page}` : ""} – ${site.siteName}`;
  const address = page > 1 ? pagePath(slug, page).slice(1) : slug;
  const description =
    archive.description ||
    excerptOf(
      `${archive.kind === "category" ? "Posts in the category" : "Posts tagged"} ${archive.name} on ${site.siteName}.`,
    );
  return {
    ...iconsOf(site),
    title,
    description,
    alternates: {
      canonical: canonicalFor(address),
      ...(options.feeds && archive.kind === "category"
        ? {
            types: {
              "application/rss+xml": `/category/${archive.slug}/feed.xml`,
              "application/atom+xml": `/category/${archive.slug}/atom.xml`,
            },
          }
        : options.feeds
          ? { types: FEEDS }
          : {}),
    },
    openGraph: {
      type: "website",
      title,
      description,
      url: canonicalFor(address),
      siteName: site.siteName,
    },
    twitter: { card: "summary", title, description },
  };
}

/** The structured data a page carries, if any: the site on the front page, a blog posting (and its breadcrumb) on a post. */
function structuredDataOf(entry: EntryView, site: SiteInfo): unknown[] {
  if (entry.slug === "home")
    return [
      websiteStructuredData({ origin: origin(), name: site.siteName, description: site.tagline }),
    ];
  if (entry.type === "post")
    return postStructuredData({
      origin: origin(),
      path: `/${entry.slug}`,
      title: entry.title,
      description: entry.description,
      image: entry.image,
      publishedAt: entry.publishedAt,
      modifiedAt: entry.updatedAt,
      authorName: entry.authorName,
      siteName: site.siteName,
    });
  return [];
}

/** The JSON-LD script of a page (nothing when it has none). The text is escaped so it cannot end the tag (SEO-28, SEO-29). */
export function EntryJsonLd({ entry, site }: { entry: EntryView; site: SiteInfo }) {
  const data = structuredDataOf(entry, site);
  if (data.length === 0) return null;
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(data) }} />;
}
