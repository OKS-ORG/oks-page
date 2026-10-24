// The header contract between the site and a CDN (decision D81, caching and CDN research section 4).
// Pure functions: what to send for a request, given the CDN setting and who is asking.

export const PUBLIC_PAGE = "public, s-maxage=300, stale-while-revalidate=3600";
export const PUBLIC_NOT_FOUND = "public, s-maxage=60";
export const PRIVATE = "private, no-store";
/** What Next.js sends for a page made on request when we say nothing. */
export const PRIVATE_PAGE = "private, no-cache, no-store, max-age=0, must-revalidate";
/** The request header the proxy uses to tell the 404 handler which Cache-Control to send. */
export const NOT_FOUND_CACHE_HEADER = "x-oks-not-found-cache";

export type Visitor = "anonymous" | "signed-in" | "preview";

/** Cookies that mean "this response is for one person": a session, or Draft Mode and previews. Never cached by a CDN. */
const SESSION_COOKIE = /session_token/;
const PREVIEW_COOKIES = ["__prerender_bypass", "__next_preview_data"];

export function visitorOf(cookieNames: string[]): Visitor {
  if (cookieNames.some((n) => PREVIEW_COOKIES.includes(n))) return "preview";
  if (cookieNames.some((n) => SESSION_COOKIE.test(n))) return "signed-in";
  return "anonymous";
}

/**
 * Headers for a published page. With the CDN setting off, anonymous visitors get what Next.js sends on its own
 * (private, no-cache), so nothing changes for sites without a CDN.
 */
export function pageHeaders(o: {
  cdn: boolean;
  visitor: Visitor;
  tags: string[];
}): Record<string, string> {
  if (o.visitor !== "anonymous") return { "cache-control": PRIVATE };
  if (!o.cdn) return {};
  return { "cache-control": PUBLIC_PAGE, "cache-tag": o.tags.join(",") };
}

/** Headers for an address with no published entry. A short public cache keeps made-up addresses off the server. */
export function notFoundHeaders(o: { cdn: boolean; visitor: Visitor }): Record<string, string> {
  if (o.visitor !== "anonymous") return { "cache-control": PRIVATE };
  return o.cdn ? { "cache-control": PUBLIC_NOT_FOUND } : {};
}
