// The feeds (spec 08, section 12): `/feed.xml` (RSS 2.0) and `/atom.xml` (Atom) for the blog, and the same for each
// category at `/category/<address>/feed.xml` and `/category/<address>/atom.xml`. They hold the newest 20 posts with the full
// text. Not there (404) when the owner asked search engines to stay away, and for a category that does not exist.
import { buildAtom, buildRss, type FeedInfo } from "@oks-page/core";
import { connection } from "next/server";
import { getSiteInfo } from "./data/server";
import { slugOf } from "./data/entries";
import { getFeedPosts } from "./feed-data";
import { readingSettings, seoSettings } from "./settings";
import { siteOrigin } from "./site-origin";

type Kind = "rss" | "atom";

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
  });

async function respond(request: Request, kind: Kind, categorySlug: string | null) {
  await connection();
  if ((await seoSettings()).discourageIndexing) return notFound();
  const feed = await getFeedPosts(categorySlug);
  if (!feed) return notFound();
  const site = await getSiteInfo();
  const file = kind === "rss" ? "feed.xml" : "atom.xml";
  const category = feed.category;
  const info: FeedInfo = {
    origin: siteOrigin(request),
    siteName: site.siteName,
    description: category ? `Posts in the category ${category.name}.` : site.tagline,
    homePath: category ? `/category/${category.slug}` : "/",
    selfPath: category ? `/category/${category.slug}/${file}` : `/${file}`,
    title: category ? `${category.name} – ${site.siteName}` : site.siteName,
    fullText: (await readingSettings()).feedFullText,
  };
  const body = kind === "rss" ? buildRss(info, feed.items) : buildAtom(info, feed.items);
  return new Response(body, {
    headers: {
      "content-type":
        kind === "rss"
          ? "application/rss+xml; charset=utf-8"
          : "application/atom+xml; charset=utf-8",
    },
  });
}

type CategoryContext = { params: Promise<{ slug: string }> };
const categoryOf = async (context: CategoryContext) => slugOf([(await context.params).slug]);

export const siteRss = (request: Request) => respond(request, "rss", null);
export const siteAtom = (request: Request) => respond(request, "atom", null);
export const categoryRss = async (request: Request, context: CategoryContext) =>
  respond(request, "rss", await categoryOf(context));
export const categoryAtom = async (request: Request, context: CategoryContext) =>
  respond(request, "atom", await categoryOf(context));
