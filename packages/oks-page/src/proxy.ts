// Runs before every page request.
//  1. An address with no published entry gets a real 404 here, before any page work, so a draft, a private, a
//     trashed or a scheduled entry is not reachable (SEO-50), and a made-up address does not fill the cache.
//     The lookup is one indexed read (SEO-51: under 5 ms at the 95th percentile).
//  2. The cache headers for a CDN (decision D81): see headers.ts.
import { countRedirectHit } from "@oks-page/core";
import { NextResponse, type NextRequest } from "next/server";
import { findAddress, findTermArchive, slugOf } from "./data/entries";
import { getRunner, getSiteId, NO_SITE } from "./db";
import {
  NOT_FOUND_CACHE_HEADER,
  PRIVATE,
  notFoundHeaders,
  pageHeaders,
  visitorOf,
} from "./headers";
import { mayPassMaintenance } from "./maintenance-gate";
import { mayPreview } from "./preview-gate";
import { cdnEnabled, maintenanceSettings, readingRoutes, seoSettings } from "./settings";

/** Every page shows the header and footer menus, so a CDN purge of a menu reaches every page. */
const MENU_TAGS = ["menu:primary", "menu:footer"];

export async function proxy(request: NextRequest) {
  // The address as stored: decoded, and in the composed Unicode form (a browser may send the same word decomposed).
  // A broken percent-encoding is a bad request (400), not a server error (spec 08, section 4).
  let decoded: string;
  try {
    decoded = decodeURIComponent(request.nextUrl.pathname);
  } catch {
    return new NextResponse("Bad request", { status: 400, headers: { "x-robots-tag": "noindex" } });
  }
  const path = decoded.normalize("NFC").replace(/\/+$/, "");
  const slug = slugOf(path === "" ? undefined : path.slice(1).split("/"));
  const started = performance.now();
  let found: Awaited<ReturnType<typeof findAddress>>["entry"];
  let archive: Awaited<ReturnType<typeof findTermArchive>> = null;
  let moved: Awaited<ReturnType<typeof findAddress>>["redirect"] = null;
  let address: Awaited<ReturnType<typeof findAddress>>;
  let cdn: boolean;
  let maintenance: Awaited<ReturnType<typeof maintenanceSettings>>;
  let seo: Awaited<ReturnType<typeof seoSettings>>;
  let reading: Awaited<ReturnType<typeof readingRoutes>>;
  try {
    [address, cdn, maintenance, seo, reading] = await Promise.all([
      // The entry and the redirect in one round trip.
      findAddress(slug, path),
      cdnEnabled(),
      maintenanceSettings(),
      seoSettings(),
      readingRoutes(),
    ]);
    found = address.entry;
    // Not an entry: it may be a category or tag archive. Only addresses of that shape cost a second read.
    if (!found) archive = await findTermArchive(slug);
    // Still nothing: it may be an old address that was redirected (a page that got a new address, or one set by hand).
    if (!found && !archive && path !== "") moved = address.redirect;
  } catch (error) {
    // A new install has no site yet: the first visit goes to the setup wizard (installation guide, "First run").
    if (error instanceof Error && error.message === NO_SITE)
      return NextResponse.redirect(new URL("/admin/setup", request.url));
    throw error;
  }
  if (process.env["OKS_TEST"])
    ((globalThis as { __oksProxyMs?: number[] }).__oksProxyMs ??= []).push(
      performance.now() - started,
    );
  const visitor = visitorOf(request.cookies.getAll().map((c) => c.name));

  // When the owner asked search engines to stay away, every public answer says so (robots.txt says it too).
  const stayAway: Record<string, string> = seo.discourageIndexing
    ? { "x-robots-tag": "noindex, nofollow" }
    : {};
  const apply = (response: NextResponse, headers: Record<string, string>) => {
    for (const [name, value] of Object.entries({ ...stayAway, ...headers }))
      response.headers.set(name, value);
    return response;
  };
  // Maintenance mode: visitors get the 503 page. Only a signed-in administrator sees the real site, and the session is
  // checked for real (a made-up cookie does not pass). The admin and the API are not behind this proxy, so the owner
  // can always sign in and turn the mode off.
  if (maintenance.enabled && !(visitor === "signed-in" && (await mayPassMaintenance(request))))
    return apply(NextResponse.rewrite(new URL("/maintenance-handler", request.url)), {
      "x-robots-tag": "noindex",
    });
  // A preview ("/preview/<id>") is for someone with a preview link or a signed-in editor of that entry. Anyone else falls
  // through to the plain 404 below, so nobody learns that a draft exists. Never cached, never indexed, and the link is
  // not passed on to other sites in a Referer header.
  const preview = /^preview\/([^/]+)$/.exec(slug);
  if (
    preview &&
    (await mayPreview(request.headers, preview[1]!, request.nextUrl.searchParams.get("t")))
  )
    return apply(NextResponse.next(), {
      "x-robots-tag": "noindex, nofollow",
      "cache-control": PRIVATE,
      "referrer-policy": "no-referrer",
    });
  // The search page is a route of its own. Its answers depend on the query, so they carry no cache tags, and search
  // engines are told not to index them (spec 08, section 9).
  if (slug === "search")
    return apply(NextResponse.next(), { "x-robots-tag": "noindex", "cache-control": PRIVATE });
  // The feed of a category ("category/news/feed.xml" and ".../atom.xml") is a route of its own; only a category that exists
  // gets through, anything else is the plain 404 below.
  const categoryFeed = /^category\/([^/]+)\/(?:feed|atom)\.xml$/.exec(slug);
  if (categoryFeed && (await findTermArchive(`category/${categoryFeed[1]}`)))
    return apply(NextResponse.next(), {});
  // Settings > Reading: the chosen home page's own address leads to "/" (one address per page), and "/" is always a page
  // when the home page shows the newest posts or a chosen page.
  if (reading.homeShows === "page" && reading.homeSlug !== "home" && slug === reading.homeSlug)
    return apply(NextResponse.redirect(new URL("/", request.url), 308), {});
  if (slug === "home" && (reading.homeShows === "posts" || reading.homeSlug !== "home")) {
    const tags = [`site:${await getSiteId()}`, "feed", ...MENU_TAGS];
    return apply(NextResponse.next(), pageHeaders({ cdn, visitor, tags }));
  }
  if (found) {
    const tags = [
      `site:${await getSiteId()}`,
      `entry:${found.id}`,
      `type:${found.type}`,
      ...MENU_TAGS,
    ];
    return apply(NextResponse.next(), pageHeaders({ cdn, visitor, tags }));
  }
  if (archive) {
    const tags = [`site:${await getSiteId()}`, `term:${archive.id}`, ...MENU_TAGS];
    return apply(NextResponse.next(), pageHeaders({ cdn, visitor, tags }));
  }
  if (moved) {
    // Go to the new address and keep the query string ("?utm_source=..."), then count the use (never slows the answer).
    const to = new URL(moved.to, request.url);
    if (moved.to.startsWith("/")) to.search = request.nextUrl.search;
    void countRedirectHit(getRunner(), moved.id).catch(() => undefined);
    return NextResponse.redirect(to, moved.status);
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
  matcher: [
    "/((?!api|admin|_next|robots.txt|sitemap.xml|feed.xml|atom.xml|not-found-handler|maintenance-handler|test-form|favicon.ico).*)",
  ],
};
