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

/**
 * The numbers to show under a list: the first page, the last page, and the pages next to the current one (two each side).
 * A hole of one page is filled with that page (a gap sign for one page would be longer than the page), a bigger hole is
 * "gap". Short lists show every number.
 */
export function pageNumbers(page: number, pages: number): (number | "gap")[] {
  const wanted = new Set<number>([1, pages]);
  for (let n = page - 2; n <= page + 2; n++) if (n >= 1 && n <= pages) wanted.add(n);
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((n, i) => {
    const before = sorted[i - 1];
    if (before !== undefined && n - before === 2) out.push(before + 1);
    else if (before !== undefined && n - before > 2) out.push("gap");
    out.push(n);
  });
  return out;
}
