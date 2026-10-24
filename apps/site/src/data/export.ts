// The data module for the export build (static mode): no cache, read once while the files are made.
import { loadPublishedEntry, slugOf } from "./entries";
import type { EntryView } from "./types";

export { slugOf };
export type { EntryView };

export async function getPublishedEntry(slug: string): Promise<EntryView | null> {
  return loadPublishedEntry(slug);
}
