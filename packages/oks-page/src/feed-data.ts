// The posts of a feed, kept in the Next.js cache with the tag `feed`, which every change to a post or a term refreshes (see
// refresh-cache.ts), so a new post is in the feed on the next request.
import { loadFeedPosts, type FeedPosts } from "@oks-page/core";
import { cacheTag } from "next/cache";
import { getRunner, getSiteId } from "./db";

/** The whole blog (null) or one category by its address ("news"); null when the category does not exist. */
export async function getFeedPosts(categorySlug: string | null): Promise<FeedPosts | null> {
  "use cache";
  cacheTag("site", "feed");
  return loadFeedPosts(getRunner(), await getSiteId(), categorySlug);
}
