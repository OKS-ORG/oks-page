// The sitemap's list of addresses. Kept in the Next.js cache with the tag `sitemap`, which is refreshed whenever a post,
// a page or a term changes (see refresh-cache.ts), so a new page is in the sitemap on the next request, as spec 08
// section 8 requires. (A sitemap that reads the database directly is built once and never changes.)
import { loadSitemapUrls, type SitemapUrl } from "@oks-page/core";
import { cacheTag } from "next/cache";
import { getRunner, getSiteId } from "./db";

export async function getSitemapUrls(): Promise<SitemapUrl[]> {
  "use cache";
  cacheTag("sitemap");
  return loadSitemapUrls(getRunner(), await getSiteId());
}
