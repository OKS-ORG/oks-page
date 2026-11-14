// The page for the export build (static mode): the same output as the server build's page, plus the list of pages to
// write. Used in place of app/[[...slug]]/page.tsx by scripts/build-export.mjs. A static export has no feeds, so the
// pages carry no feed links.
import {
  allSlugParams,
  getPostSummaries,
  getPublishedEntry,
  getReading,
  getSiteInfo,
  getSiteMenu,
  getTermArchive,
  getThemeLayouts,
  slugOf,
} from "./data/export";
import { layoutCandidates, pickLayout, type PageKind } from "@oks-page/core";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { Card, CardBody } from "oks-ui/card";
import { ArchiveContent, ArchiveView, archiveTitle } from "./archive-view";
import { EntryJsonLd, archiveMetadata, entryMetadata } from "./page-meta";
import { PostsList } from "./posts-list";
import { PublicFrame } from "./public-frame";
import { ThemedPage, type ThemedPageInfo } from "./theme-layout";

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateStaticParams() {
  return allSlugParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const asked = slugOf((await params).slug);
  const route = await readingPage(asked);
  if ("posts" in route || "redirect" in route) return {};
  const slug = route.entrySlug;
  const entry = await getPublishedEntry(slug);
  if (entry) return entryMetadata(entry, await getSiteInfo(), { feeds: false });
  const archive = await getTermArchive(slug);
  return archive ? archiveMetadata(archive, slug, await getSiteInfo(), { feeds: false }) : {};
}

export default async function Page({ params }: Props) {
  const asked = slugOf((await params).slug);
  const route = await readingPage(asked);
  if ("redirect" in route) permanentRedirect(route.redirect);
  if ("posts" in route) return route.posts;
  const slug = route.entrySlug;
  const entry = await getPublishedEntry(slug);
  if (!entry) {
    const archive = await getTermArchive(slug);
    if (!archive) notFound();
    const drawn = await themed(
      { kind: "archive", termKind: archive.kind },
      {
        title: archiveTitle(archive),
        content: <ArchiveContent archive={archive} />,
        meta: null,
        isFront: false,
        pagefind: true,
      },
    );
    if (drawn) return drawn;
    const [header, footer] = await Promise.all([getSiteMenu("primary"), getSiteMenu("footer")]);
    return (
      <PublicFrame header={header} footer={footer}>
        <ArchiveView archive={archive} />
      </PublicFrame>
    );
  }
  const drawn = await themed(
    { kind: "entry", type: entry.type, slug, chosen: entry.layout },
    {
      title: entry.title,
      content: <article dangerouslySetInnerHTML={{ __html: entry.html }} />,
      meta:
        entry.type === "post"
          ? { publishedAt: entry.publishedAt, authorName: entry.authorName }
          : null,
      isFront: asked === "home",
      pagefind: true,
    },
  );
  if (drawn)
    return (
      <>
        {drawn}
        <EntryJsonLd entry={entry} site={await getSiteInfo()} />
      </>
    );
  const [header, footer, site] = await Promise.all([
    getSiteMenu("primary"),
    getSiteMenu("footer"),
    getSiteInfo(),
  ]);
  return (
    <PublicFrame header={header} footer={footer}>
      <main data-pagefind-body>
        <h1>{entry.title}</h1>
        <Card>
          <CardBody>
            <article dangerouslySetInnerHTML={{ __html: entry.html }} />
          </CardBody>
        </Card>
      </main>
      <EntryJsonLd entry={entry} site={site} />
    </PublicFrame>
  );
}

/** The page drawn from the theme's layout for it, or null when the theme has none (or no theme is in use). */
async function themed(kind: PageKind, page: ThemedPageInfo): Promise<ReactNode | null> {
  const layouts = await getThemeLayouts();
  const layout = pickLayout(layouts, layoutCandidates(kind));
  return layout && layouts ? (
    <ThemedPage layout={layout} parts={layouts.parts} page={page} />
  ) : null;
}

/**
 * What an address shows under Settings > Reading: the newest posts at "/" (when the home page shows them) or at the posts
 * page's address; the chosen home page at "/" (its own address then sends visitors to "/").
 */
async function readingPage(
  slug: string,
): Promise<{ posts: ReactNode } | { entrySlug: string } | { redirect: string }> {
  const reading = await getReading();
  if (slug === "home" && reading.homeShows === "posts")
    return {
      posts: await postsPage(reading.perPage, await getSiteInfo().then((s) => s.siteName), true),
    };
  if (reading.postsSlug && slug === reading.postsSlug)
    return { posts: await postsPage(reading.perPage, reading.postsTitle, false) };
  if (reading.homeShows === "page" && reading.homeSlug !== "home") {
    if (slug === "home") return { entrySlug: reading.homeSlug };
    if (slug === reading.homeSlug) return { redirect: "/" };
  }
  return { entrySlug: slug };
}

/** The newest posts, drawn with the theme's "home" (or "index") layout when there is one. */
async function postsPage(perPage: number, title: string, isFront: boolean): Promise<ReactNode> {
  const posts = await getPostSummaries(perPage);
  const drawn = await themed(
    { kind: "posts" },
    {
      title,
      content: <PostsList posts={posts} />,
      meta: null,
      isFront,
    },
  );
  if (drawn) return drawn;
  const [header, footer] = await Promise.all([getSiteMenu("primary"), getSiteMenu("footer")]);
  return (
    <PublicFrame header={header} footer={footer}>
      <main>
        <h1>{title}</h1>
        <PostsList posts={posts} />
      </main>
    </PublicFrame>
  );
}
