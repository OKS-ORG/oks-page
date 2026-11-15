// The addresses of the later pages of a list (WordPress-style): "/page/2" for the newest posts, "/blog/page/2" for the posts
// page, "/category/news/page/2" for an archive. Page 1 is the list's own address. Pure, so the proxy, the pages and the
// export build all read addresses the same way.

/** The pages are numbered from 1; this is the biggest number an address can hold. */
export const MOST_PAGE_DIGITS = 6;

/**
 * Splits "category/news/page/3" into the list ("category/news") and the page (3). The list of the home page is "home". Null
 * when the address does not end in "page/<number>" written plainly (no sign, no leading zero, 1 to 999999).
 */
export function pagingOf(slug: string): { base: string; page: number } | null {
  const found = /^(?:(.+)\/)?page\/([1-9]\d{0,5})$/.exec(slug);
  if (!found) return null;
  return { base: found[1] ?? "home", page: Number(found[2]) };
}

/** The address of a page of a list: page 1 is the list itself ("/" for the home page). */
export function pagePath(base: string, page: number): string {
  const root = base === "home" ? "" : `/${base}`;
  return page <= 1 ? root || "/" : `${root}/page/${page}`;
}

/** How many pages hold this many posts (at least 1: an empty list is one empty page). */
export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, perPage)));
}
