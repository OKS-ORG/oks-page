// The data module for the server build: answers are kept in the Next.js cache, tagged so a publish can refresh
// exactly the pages that changed. Pages import this as "@data"; the export build swaps in `export.ts`.
import { cacheTag } from "next/cache";
import type { FeedItem, PublicMenuItem, ThemeLayouts } from "@oks-page/core";
import { slugTag } from "../cache-tags";
import {
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
import type { EntryView, Look, PostsPage, PostSummary, SiteInfo, TermArchive } from "./types";

export { slugOf };
export type { EntryView, Look, PostsPage, PostSummary, ReadingRoutes, SiteInfo, TermArchive };

/** Where the home page and the posts page are. Tagged `settings` and `menus` (a page's address or status changes it). */
export async function getReading(): Promise<ReadingRoutes> {
  "use cache";
  cacheTag("site", "settings", "menus");
  return loadReading();
}

/** One page of the newest posts, for the home page or the posts page. Tagged "feed": every change to a post refreshes it. */
export async function getPostsPage(perPage: number, page: number): Promise<PostsPage> {
  "use cache";
  cacheTag("site", "feed");
  return loadPostsPage(perPage, page);
}

/** The site's name and tagline, for every page's title and tags. Tagged `settings`: refreshed when they are saved. */
export async function getSiteInfo(): Promise<SiteInfo> {
  "use cache";
  cacheTag("site", "settings");
  return loadSiteInfo();
}

/** The look (the theme in use, colors, fonts, logo). Tagged "theme": refreshed when the look or the theme changes. */
export async function getLook(): Promise<Look> {
  "use cache";
  cacheTag("site", "theme", "settings");
  return loadLook();
}

/** The layouts of the theme in use. Tagged "theme": refreshed when a theme is used, updated or rolled back. */
export async function getThemeLayouts(): Promise<ThemeLayouts | null> {
  "use cache";
  cacheTag("site", "theme");
  return loadThemeLayouts();
}

/** The newest posts, for a theme's list of latest posts. Tagged "feed": every change to a post refreshes it. */
export async function getLatestPosts(): Promise<FeedItem[]> {
  "use cache";
  cacheTag("site", "feed");
  return loadLatestPosts();
}

// Test builds count how often a page is really read from the database.
const loads = globalThis as typeof globalThis & { __oksLoads?: Record<string, number> };
const count = (key: string) => {
  if (process.env["OKS_TEST"])
    (loads.__oksLoads ??= {})[key] = ((loads.__oksLoads ??= {})[key] ?? 0) + 1;
};

export async function getPublishedEntry(slug: string): Promise<EntryView | null> {
  "use cache";
  cacheTag("site", slugTag(slug));
  count(`entry:${slug}`);
  const entry = await loadPublishedEntry(slug);
  if (entry) cacheTag(`entry:${entry.id}`);
  return entry;
}

/**
 * The header or footer menu. Tagged `menus` (refreshed whenever a menu, a page's address or status, or a term changes)
 * and `menu:<place>`.
 */
export async function getSiteMenu(place: string): Promise<PublicMenuItem[]> {
  "use cache";
  cacheTag("site", "menus", `menu:${place}`);
  count(`menu:${place}`);
  return loadSiteMenu(place);
}

/** One page of a category or tag archive ("category/travel"). Refreshed whenever a post or a term changes (tag "archive:posts"). */
export async function getTermArchive(
  slug: string,
  perPage = 10,
  page = 1,
): Promise<TermArchive | null> {
  "use cache";
  cacheTag("site", "archive:posts");
  count(`archive:${slug}`);
  const archive = await loadTermArchive(slug, perPage, page);
  if (archive) cacheTag(`term:${archive.id}`);
  return archive;
}
