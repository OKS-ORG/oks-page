// The data module for the export build (static mode): no cache, read once while the files are made.
import { loadPublishedEntry, slugOf } from "./entries";
import type { EntryView } from "./types";

export { slugOf };
export type { EntryView };

export async function getPublishedEntry(slug: string): Promise<EntryView | null> {
  return loadPublishedEntry(slug);
}

import { listPublishedSlugs } from "./entries";

/** The pages to write, as the route parameters of `[[...slug]]`: "home" is the empty list (the front page). */
export async function allSlugParams(): Promise<{ slug: string[] }[]> {
  return (await listPublishedSlugs()).map((s) => ({ slug: s === "home" ? [] : s.split("/") }));
}
