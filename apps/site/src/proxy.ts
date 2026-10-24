// Runs before every page request. An address with no published entry gets a real 404 here, before any page
// work, so a draft, a private, a trashed or a scheduled entry is not reachable (SEO-50), and a made-up address
// does not fill the cache. The lookup is one indexed read (SEO-51: under 5 ms at the 95th percentile).
import { NextResponse, type NextRequest } from "next/server";
import { publishedSlugExists, slugOf } from "./data/entries";

export async function proxy(request: NextRequest) {
  const path = decodeURIComponent(request.nextUrl.pathname).replace(/\/+$/, "");
  const slug = slugOf(path === "" ? undefined : path.slice(1).split("/"));
  const started = performance.now();
  const found = await publishedSlugExists(slug);
  if (process.env["OKS_TEST"])
    ((globalThis as { __oksProxyMs?: number[] }).__oksProxyMs ??= []).push(
      performance.now() - started,
    );
  if (found) return NextResponse.next();
  return NextResponse.rewrite(new URL("/not-found-handler", request.url));
}

export const config = {
  matcher: ["/((?!api|admin|_next|robots.txt|sitemap.xml|not-found-handler|favicon.ico).*)"],
};
