// Runs before every page request.
//  1. An address with no published entry gets a real 404 here, before any page work, so a draft, a private, a
//     trashed or a scheduled entry is not reachable (SEO-50), and a made-up address does not fill the cache.
//     The lookup is one indexed read (SEO-51: under 5 ms at the 95th percentile).
//  2. The cache headers for a CDN (decision D81): see headers.ts.
import { NextResponse, type NextRequest } from "next/server";
import { findPublished, slugOf } from "./data/entries";
import { getSiteId } from "./db";
import { NOT_FOUND_CACHE_HEADER, notFoundHeaders, pageHeaders, visitorOf } from "./headers";
import { cdnEnabled } from "./settings";

export async function proxy(request: NextRequest) {
  const path = decodeURIComponent(request.nextUrl.pathname).replace(/\/+$/, "");
  const slug = slugOf(path === "" ? undefined : path.slice(1).split("/"));
  const started = performance.now();
  const [found, cdn] = await Promise.all([findPublished(slug), cdnEnabled()]);
  if (process.env["OKS_TEST"])
    ((globalThis as { __oksProxyMs?: number[] }).__oksProxyMs ??= []).push(
      performance.now() - started,
    );
  const visitor = visitorOf(request.cookies.getAll().map((c) => c.name));

  const apply = (response: NextResponse, headers: Record<string, string>) => {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };
  if (found) {
    const tags = [`site:${await getSiteId()}`, `entry:${found.id}`, `type:${found.type}`];
    return apply(NextResponse.next(), pageHeaders({ cdn, visitor, tags }));
  }
  // The 404 handler sends the cache header itself (Next.js would replace one set here), so it is passed on as a request header.
  const wanted = notFoundHeaders({ cdn, visitor })["cache-control"];
  const headers = new Headers(request.headers);
  headers.delete(NOT_FOUND_CACHE_HEADER);
  if (wanted) headers.set(NOT_FOUND_CACHE_HEADER, wanted);
  return apply(
    NextResponse.rewrite(new URL("/not-found-handler", request.url), { request: { headers } }),
    { "x-robots-tag": "noindex" },
  );
}

export const config = {
  matcher: ["/((?!api|admin|_next|robots.txt|sitemap.xml|not-found-handler|favicon.ico).*)"],
};
