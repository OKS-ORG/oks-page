// The data module for the export build (static mode): no cache, read once while the files are made.
import type { FeedItem, PublicMenuItem, ThemeLayouts } from "@oks-page/core";
import {
  listPages,
  loadPostsPage,
  loadPublishedEntry,
  loadReading,
  loadSiteInfo,
  loadLatestPosts,
  loadLook,
  loadSiteMenu,
  loadTermArchive,
  loadThemeLayouts,
  slugOf,
} from "./entries";
import type { ReadingRoutes } from "@oks-page/core";
import { pagePath } from "../paging";
import type { EntryView, Look, PostsPage, PostSummary, SiteInfo, TermArchive } from "./types";

export { slugOf };
export type { EntryView, Look, PostsPage, PostSummary, ReadingRoutes, SiteInfo, TermArchive };

export async function getReading(): Promise<ReadingRoutes> {
  return loadReading();
}

export async function getPostsPage(perPage: number, page: number): Promise<PostsPage> {
  return loadPostsPage(perPage, page);
}

export async function getSiteInfo(): Promise<SiteInfo> {
  return loadSiteInfo();
}

export async function getLook(): Promise<Look> {
  return loadLook();
}

export async function getThemeLayouts(): Promise<ThemeLayouts | null> {
  return loadThemeLayouts();
}

export async function getLatestPosts(): Promise<FeedItem[]> {
  return loadLatestPosts();
}

export async function getPublishedEntry(slug: string): Promise<EntryView | null> {
  return loadPublishedEntry(slug);
}

import { listArchiveSlugs, listPublishedSlugs } from "./entries";

export async function getSiteMenu(place: string): Promise<PublicMenuItem[]> {
  return loadSiteMenu(place);
}

export async function getTermArchive(
  slug: string,
  perPage = 10,
  page = 1,
): Promise<TermArchive | null> {
  return loadTermArchive(slug, perPage, page);
}

/** The pages to write, as the route parameters of `[[...slug]]`: "home" is the empty list (the front page). */
export async function allSlugParams(): Promise<{ slug: string[] }[]> {
  const slugs = [...(await listPublishedSlugs())];
  // A term whose address is also an entry's address shows the entry, so it is not written twice.
  for (const archive of await listArchiveSlugs()) if (!slugs.includes(archive)) slugs.push(archive);
  // The home page shows the newest posts, or a chosen page: "/" is written either way.
  if (!slugs.includes("home")) slugs.push("home");
  // The later pages of every list: the newest posts, the posts page and each archive.
  const reading = await loadReading();
  for (const list of [
    "home",
    ...(reading.postsSlug ? [reading.postsSlug] : []),
    ...(await listArchiveSlugs()),
  ]) {
    const info = await listPages(list, reading.perPage, reading);
    for (let page = 2; page <= (info?.pages ?? 1); page++) {
      const address = pagePath(list, page).slice(1);
      // An entry that has the address of a later page shows the entry, so it is not written twice.
      if (!slugs.includes(address)) slugs.push(address);
    }
  }
  return slugs.map((s) => ({ slug: s === "home" ? [] : s.split("/") }));
}
