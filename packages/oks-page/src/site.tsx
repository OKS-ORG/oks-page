import {
  getPostsPage,
  getPublishedEntry,
  getReading,
  getSiteInfo,
  getSiteMenu,
  getTermArchive,
  getThemeLayouts,
  getTypeList,
  slugOf,
} from "@data";
import { layoutCandidates, pickLayout, type PageKind } from "@oks-page/core";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { Card, CardBody } from "oks-ui/card";
import { ArchiveContent, ArchiveView, archiveTitle } from "./archive-view";
import type { TermArchive, TypeList } from "./data/types";
import {
  EntryJsonLd,
  archiveMetadata,
  entryMetadata,
  postsMetadata,
  typeListMetadata,
} from "./page-meta";
import { EntryLinks, EntryPictures } from "./entry-pictures";
import { Pager } from "./pager";
import { pagePath, pagingOf } from "./paging";
import { PostsList } from "./posts-list";
import { PublicFrame } from "./public-frame";
import { CommentsSection } from "./comments-section";
import { ThemedPage, type ThemedPageInfo } from "./theme-layout";

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const asked = slugOf((await params).slug);
  // The later pages of a list ("page/2", "category/news/page/2") unless an entry has that very address.
  const paging = pagingOf(asked);
  if (paging && !(await getPublishedEntry(asked))) return pagedMetadata(paging.base, paging.page);
  const route = await readingPage(asked);
  if ("redirect" in route) return {};
  if ("posts" in route) {
    const reading = await getReading();
    const site = await getSiteInfo();
    return asked === "home"
      ? postsMetadata(site.siteName, "home", site, true)
      : postsMetadata(reading.postsTitle, asked, site, false);
  }
  const slug = route.entrySlug;
  const entry = await getPublishedEntry(slug);
  if (entry)
    return entryMetadata(entry, await getSiteInfo(), { feeds: true, front: asked === "home" });
  const perPage = (await getReading()).perPage;
  const archive = await getTermArchive(slug, perPage, 1);
  if (archive) return archiveMetadata(archive, slug, await getSiteInfo(), { feeds: true });
  const list = await getTypeList(slug, perPage, 1);
  return list ? typeListMetadata(list, await getSiteInfo()) : {};
}

export default async function Page({ params }: Props) {
  const asked = slugOf((await params).slug);
  const paging = pagingOf(asked);
  if (paging && !(await getPublishedEntry(asked))) return pagedPage(paging.base, paging.page);
  const route = await readingPage(asked);
  if ("redirect" in route) permanentRedirect(route.redirect);
  if ("posts" in route) return route.posts;
  const slug = route.entrySlug;
  const entry = await getPublishedEntry(slug);
  if (!entry) {
    // An address that is not an entry may be a category or tag archive ("category/travel").
    const perPage = (await getReading()).perPage;
    const archive = await getTermArchive(slug, perPage, 1);
    if (archive) return archiveNode(archive);
    // Or the list of a custom type ("shop" for the address prefix "shop/").
    const list = await getTypeList(slug, perPage, 1);
    if (!list) notFound();
    return typeListNode(list);
  }
  const drawn = await themed(
    { kind: "entry", type: entry.type, slug, chosen: entry.layout },
    {
      title: entry.title,
      content: (
        <>
          <EntryPictures pictures={entry.pictures} />
          <EntryLinks links={entry.links} />
          <article dangerouslySetInnerHTML={{ __html: entry.html }} />
          {entry.type === "post" ? <CommentsSection entryId={entry.id} slug={slug} /> : null}
        </>
      ),
      meta:
        entry.type === "post"
          ? { publishedAt: entry.publishedAt, authorName: entry.authorName }
          : null,
      isFront: asked === "home",
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
      <main>
        <h1>{entry.title}</h1>
        <Card>
          <CardBody>
            <EntryPictures pictures={entry.pictures} />
            <EntryLinks links={entry.links} />
            <article dangerouslySetInnerHTML={{ __html: entry.html }} />
          </CardBody>
        </Card>
        {entry.type === "post" ? <CommentsSection entryId={entry.id} slug={slug} /> : null}
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
      posts: await postsPage(
        reading.perPage,
        await getSiteInfo().then((s) => s.siteName),
        true,
        "home",
      ),
    };
  if (reading.postsSlug && slug === reading.postsSlug)
    return {
      posts: await postsPage(reading.perPage, reading.postsTitle, false, reading.postsSlug),
    };
  if (reading.homeShows === "page" && reading.homeSlug !== "home") {
    if (slug === "home") return { entrySlug: reading.homeSlug };
    if (slug === reading.homeSlug) return { redirect: "/" };
  }
  return { entrySlug: slug };
}

/** The newest posts, drawn with the theme's "home" (or "index") layout when there is one. */
async function postsPage(
  perPage: number,
  title: string,
  isFront: boolean,
  base = "home",
  page = 1,
): Promise<ReactNode> {
  const result = await getPostsPage(perPage, page);
  if (page > result.pages) notFound();
  const list = (
    <>
      <PostsList posts={result.posts} />
      <Pager base={base} page={page} pages={result.pages} />
    </>
  );
  const drawn = await themed(
    { kind: "posts" },
    {
      title,
      content: list,
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
        {list}
      </main>
    </PublicFrame>
  );
}

/** Whether an address is a list of the newest posts: the home page when it shows them, or the posts page. */
function isPostsList(base: string, reading: Awaited<ReturnType<typeof getReading>>): boolean {
  return (
    (base === "home" && reading.homeShows === "posts") ||
    (reading.postsSlug !== null && base === reading.postsSlug)
  );
}

/** A category or tag archive, drawn with the theme's archive layout when there is one. */
async function archiveNode(archive: TermArchive): Promise<ReactNode> {
  const drawn = await themed(
    { kind: "archive", termKind: archive.kind },
    {
      title: archiveTitle(archive),
      content: <ArchiveContent archive={archive} />,
      meta: null,
      isFront: false,
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

/** The list of a custom type, drawn with the theme's "list-<type>" or archive layout when there is one. */
async function typeListNode(list: TypeList): Promise<ReactNode> {
  const content = (
    <>
      <PostsList posts={list.posts} empty="There is nothing here yet." />
      <Pager base={list.base} page={list.page} pages={list.pages} />
    </>
  );
  const drawn = await themed(
    { kind: "type-list", type: list.key },
    { title: list.label, content, meta: null, isFront: false },
  );
  if (drawn) return drawn;
  const [header, footer] = await Promise.all([getSiteMenu("primary"), getSiteMenu("footer")]);
  return (
    <PublicFrame header={header} footer={footer}>
      <main>
        <h1>{list.label}</h1>
        {content}
      </main>
    </PublicFrame>
  );
}

/**
 * A later page of a list: "page/2" (the newest posts), "<posts page>/page/2" or "category/news/page/2". Page 1 is the
 * list's own address (a permanent redirect there); a page past the last one is a 404 (the proxy already says so).
 */
async function pagedPage(base: string, page: number): Promise<ReactNode> {
  if (page === 1) permanentRedirect(pagePath(base, 1));
  const reading = await getReading();
  if (isPostsList(base, reading)) {
    const title =
      base === "home" ? await getSiteInfo().then((s) => s.siteName) : reading.postsTitle;
    return postsPage(reading.perPage, title, base === "home", base, page);
  }
  const archive = await getTermArchive(base, reading.perPage, page);
  if (archive) {
    if (page > archive.pages) notFound();
    return archiveNode(archive);
  }
  const list = await getTypeList(base, reading.perPage, page);
  if (!list || page > list.pages) notFound();
  return typeListNode(list);
}

async function pagedMetadata(base: string, page: number): Promise<Metadata> {
  if (page === 1) return {};
  const reading = await getReading();
  const site = await getSiteInfo();
  if (isPostsList(base, reading))
    return postsMetadata(
      base === "home" ? "Latest posts" : reading.postsTitle,
      base,
      site,
      false,
      page,
    );
  const archive = await getTermArchive(base, reading.perPage, page);
  if (archive) return archiveMetadata(archive, base, site, { feeds: true }, page);
  const list = await getTypeList(base, reading.perPage, page);
  return list ? typeListMetadata(list, site, page) : {};
}
