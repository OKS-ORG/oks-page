// The data module for the export build (static mode): no cache, read once while the files are made.
import { loadPublishedEntry, loadTermArchive, slugOf } from "./entries";
import type { EntryView, TermArchive } from "./types";

export { slugOf };
export type { EntryView, TermArchive };

export async function getPublishedEntry(slug: string): Promise<EntryView | null> {
  return loadPublishedEntry(slug);
}

import { listArchiveSlugs, listPublishedSlugs } from "./entries";

export async function getTermArchive(slug: string): Promise<TermArchive | null> {
  return loadTermArchive(slug);
}

/** The pages to write, as the route parameters of `[[...slug]]`: "home" is the empty list (the front page). */
export async function allSlugParams(): Promise<{ slug: string[] }[]> {
  const slugs = [...(await listPublishedSlugs())];
  // A term whose address is also an entry's address shows the entry, so it is not written twice.
  for (const archive of await listArchiveSlugs()) if (!slugs.includes(archive)) slugs.push(archive);
  return slugs.map((s) => ({ slug: s === "home" ? [] : s.split("/") }));
}
