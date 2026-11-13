// /robots.txt, made from the settings: normally the admin, the API and the search page are closed and the sitemap is
// listed; when the owner asked search engines to stay away, everything is closed.
import { buildRobotsTxt } from "@oks-page/core";
import { connection } from "next/server";
import { seoSettings } from "./settings";
import { siteOrigin } from "./site-origin";

export async function GET(request: Request) {
  await connection();
  const { discourageIndexing } = await seoSettings();
  return new Response(buildRobotsTxt(siteOrigin(request), discourageIndexing), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
