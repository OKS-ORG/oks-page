// Runs before every page request.
//  1. An address with no published entry gets a real 404 here, before any page work, so a draft, a private, a
//     trashed or a scheduled entry is not reachable (SEO-50), and a made-up address does not fill the cache.
//     The lookup is one indexed read (SEO-51: under 5 ms at the 95th percentile).
//  2. The cache headers for a CDN (decision D81): see headers.ts.
import { NextResponse, type NextRequest } from "next/server";
import { findPublished, findTermArchive, slugOf } from "./data/entries";
import { getSiteId, NO_SITE } from "./db";
import { NOT_FOUND_CACHE_HEADER, notFoundHeaders, pageHeaders, visitorOf } from "./headers";
import { mayPassMaintenance } from "./maintenance-gate";
import { cdnEnabled, maintenanceSettings } from "./settings";

/** Every page shows the header and footer menus, so a CDN purge of a menu reaches every page. */
const MENU_TAGS = ["menu:primary", "menu:footer"];

export async function proxy(request: NextRequest) {
  const path = decodeURIComponent(request.nextUrl.pathname).replace(/\/+$/, "");
  const slug = slugOf(path === "" ? undefined : path.slice(1).split("/"));
  const started = performance.now();
  let found: Awaited<ReturnType<typeof findPublished>>;
  let archive: Awaited<ReturnType<typeof findTermArchive>> = null;
  let cdn: boolean;
  let maintenance: Awaited<ReturnType<typeof maintenanceSettings>>;
  try {
    [found, cdn, maintenance] = await Promise.all([
      findPublished(slug),
      cdnEnabled(),
      maintenanceSettings(),
    ]);
    // Not an entry: it may be a category or tag archive. Only addresses of that shape cost a second read.
    if (!found) archive = await findTermArchive(slug);
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

  const apply = (response: NextResponse, headers: Record<string, string>) => {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };
  // Maintenance mode: visitors get the 503 page. Only a signed-in administrator sees the real site, and the session is
  // checked for real (a made-up cookie does not pass). The admin and the API are not behind this proxy, so the owner
  // can always sign in and turn the mode off.
  if (maintenance.enabled && !(visitor === "signed-in" && (await mayPassMaintenance(request))))
    return apply(NextResponse.rewrite(new URL("/maintenance-handler", request.url)), {
      "x-robots-tag": "noindex",
    });
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
    "/((?!api|admin|_next|robots.txt|sitemap.xml|not-found-handler|maintenance-handler|test-form|favicon.ico).*)",
  ],
};
