// After a save the public pages that show the entry are made fresh at once (decision D82: tags, not time).
import { revalidateTag } from "next/cache";

export function refreshEntry(id: string, ...slugs: string[]): void {
  revalidateTag(`entry:${id}`, { expire: 0 });
  for (const slug of new Set(slugs)) revalidateTag(`slug:${slug}`, { expire: 0 });
}
