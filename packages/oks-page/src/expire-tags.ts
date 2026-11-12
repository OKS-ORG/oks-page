// Marks the cached copies of an entry as out of date for every server on this database, from anywhere (a request, the
// scheduler, a background job). `revalidateTag` only works inside a request; this writes the shared tag table instead.
import { getRunner } from "./db";

export async function expireTags(siteId: string, id: string, slug: string): Promise<void> {
  const now = new Date();
  for (const tag of [`entry:${id}`, `slug:${slug}`])
    await getRunner().all(
      `insert into "cache_tags" ("site_id", "tag", "stale_at", "expired_at", "updated_at") values (?, ?, ?, ?, ?)
       on conflict ("site_id", "tag") do update set
         "stale_at" = excluded."stale_at", "expired_at" = excluded."expired_at", "updated_at" = excluded."updated_at"`,
      [siteId, tag, now, now, now],
    );
}
