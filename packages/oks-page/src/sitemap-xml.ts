// /sitemap.xml: every address search engines may index. Not there (404) when the owner asked search engines to stay away.
import { buildSitemapXml } from "@oks-page/core";
import { connection } from "next/server";
import { getSitemapUrls } from "./sitemap-data";
import { seoSettings } from "./settings";
import { siteOrigin } from "./site-origin";

export async function GET(request: Request) {
  await connection();
  if ((await seoSettings()).discourageIndexing)
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
    });
  return new Response(buildSitemapXml(siteOrigin(request), await getSitemapUrls()), {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
