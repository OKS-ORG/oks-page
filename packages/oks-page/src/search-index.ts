// The site's search index, kept in memory in each server process. It is rebuilt when what it is made of changes (an
// entry published, changed or removed, found by a cheap fingerprint of the database) and at least once a minute (so a
// renamed category shows up). The process that saved a change forgets its index at once, so it shows in the very next
// search there.
import { buildIndex, loadSearchRows, searchStamp, type SearchIndex } from "@oks-page/core";
import { getRunner, getSiteId } from "./db";

const MAX_AGE_MS = 60_000;

interface Kept {
  stamp: string;
  at: number;
  index: Promise<SearchIndex>;
}
const shared = globalThis as typeof globalThis & {
  __oksSearch?: Kept | null;
  __oksSearchBuilds?: number;
};

/** Makes this process build the index again at the next search. */
export function forgetSearchIndex(): void {
  shared.__oksSearch = null;
}

export async function getSearchIndex(): Promise<SearchIndex> {
  const runner = getRunner();
  const siteId = await getSiteId();
  const stamp = await searchStamp(runner, siteId);
  const kept = shared.__oksSearch;
  if (kept && kept.stamp === stamp && Date.now() - kept.at < MAX_AGE_MS) return kept.index;
  const index = loadSearchRows(runner, siteId).then(buildIndex);
  // Test builds count how often the index is really built.
  if (process.env["OKS_TEST"]) shared.__oksSearchBuilds = (shared.__oksSearchBuilds ?? 0) + 1;
  shared.__oksSearch = { stamp, at: Date.now(), index };
  // A failed build is not kept: the next search tries again.
  index.catch(() => {
    if (shared.__oksSearch?.index === index) shared.__oksSearch = null;
  });
  return index;
}
