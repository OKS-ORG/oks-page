// After a save the public pages that show the entry are made fresh at once (decision D82: tags, not time).
import { revalidateTag } from "next/cache";
import { forgetSearchIndex } from "./search-index";

/** The header and footer menus on every page: a changed menu is shown on the next visit. */
export function refreshMenus(): void {
  revalidateTag("menus", { expire: 0 });
}

/**
 * The category and tag archives list posts and show term names, and the menus point at pages and terms by their
 * current address, so any change to a post or a term refreshes both.
 */
export function refreshArchives(): void {
  revalidateTag("archive:posts", { expire: 0 });
  refreshMenus();
  // The search index holds titles, texts and term names too: this process builds it again at the next search.
  forgetSearchIndex();
}

export function refreshEntry(id: string, ...slugs: string[]): void {
  revalidateTag(`entry:${id}`, { expire: 0 });
  for (const slug of new Set(slugs)) revalidateTag(`slug:${slug}`, { expire: 0 });
  refreshArchives();
}
