// The data module for the export build (static mode): no cache, read once while the files are made.
import type { FeedItem, PublicMenuItem, ThemeLayouts } from "@oks-page/core";
import {
  loadPostSummaries,
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
import type { EntryView, Look, PostSummary, SiteInfo, TermArchive } from "./types";

export { slugOf };
export type { EntryView, Look, PostSummary, ReadingRoutes, SiteInfo, TermArchive };

export async function getReading(): Promise<ReadingRoutes> {
  return loadReading();
}

export async function getPostSummaries(limit: number): Promise<PostSummary[]> {
  return loadPostSummaries(limit);
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

export async function getTermArchive(slug: string): Promise<TermArchive | null> {
  return loadTermArchive(slug);
}

/** The pages to write, as the route parameters of `[[...slug]]`: "home" is the empty list (the front page). */
export async function allSlugParams(): Promise<{ slug: string[] }[]> {
  const slugs = [...(await listPublishedSlugs())];
  // A term whose address is also an entry's address shows the entry, so it is not written twice.
  for (const archive of await listArchiveSlugs()) if (!slugs.includes(archive)) slugs.push(archive);
  // The home page shows the newest posts, or a chosen page: "/" is written either way.
  if (!slugs.includes("home")) slugs.push("home");
  return slugs.map((s) => ({ slug: s === "home" ? [] : s.split("/") }));
}
