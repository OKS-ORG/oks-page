// After a save the public pages that show the entry are made fresh at once (decision D82: tags, not time).
import { revalidateTag } from "next/cache";

/** The category and tag archives list posts and show term names, so any change to a post or a term refreshes them. */
export function refreshArchives(): void {
  revalidateTag("archive:posts", { expire: 0 });
}

export function refreshEntry(id: string, ...slugs: string[]): void {
  revalidateTag(`entry:${id}`, { expire: 0 });
  for (const slug of new Set(slugs)) revalidateTag(`slug:${slug}`, { expire: 0 });
  refreshArchives();
}
