// The data module for the server build: answers are kept in the Next.js cache, tagged so a publish can refresh
// exactly the pages that changed. Pages import this as "@data"; the export build swaps in `export.ts`.
import { cacheTag } from "next/cache";
import { loadPublishedEntry, slugOf } from "./entries";
import type { EntryView } from "./types";

export { slugOf };
export type { EntryView };

// Test builds count how often a page is really read from the database.
const loads = globalThis as typeof globalThis & { __oksLoads?: Record<string, number> };
const count = (key: string) => {
  if (process.env["OKS_TEST"])
    (loads.__oksLoads ??= {})[key] = ((loads.__oksLoads ??= {})[key] ?? 0) + 1;
};

export async function getPublishedEntry(slug: string): Promise<EntryView | null> {
  "use cache";
  cacheTag(`slug:${slug}`);
  count(`entry:${slug}`);
  const entry = await loadPublishedEntry(slug);
  if (entry) cacheTag(`entry:${entry.id}`);
  return entry;
}
