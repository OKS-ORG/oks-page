// Scheduled publishing (spec 03, "Scheduling and publishing"; EC-39): an entry saved with the status "scheduled" and a
// time goes live at that time. A job (a timer in the running server) calls `publishDue`. The entry is published with
// the permission of the person who scheduled it, checked at that moment: if they have lost it, the entry goes back to
// a draft instead of going live. Two servers on one database never publish the same entry twice.
import { newId, type SqlRunner } from "@oks-page/db";

export interface DueEntry {
  id: string;
  siteId: string;
  type: string;
  slug: string;
}

/** Answers: may this person publish this entry now? (The server asks the roles.) */
export type MayPublish = (who: {
  siteId: string;
  userId: string;
  type: string;
  authorId: string;
}) => Promise<boolean>;

export interface PublishDueResult {
  published: DueEntry[];
  /** Scheduled by someone who may no longer publish: these went back to drafts. */
  blocked: DueEntry[];
}

const parseJson = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;

export async function publishDue(
  runner: SqlRunner,
  mayPublish: MayPublish,
  now: () => number = Date.now,
  limit = 100,
): Promise<PublishDueResult> {
  const at = new Date(now());
  const due = await runner.all(
    `select "id", "site_id", "type_key", "slug", "author_id", "title", "body", "meta" from "entries"
      where "status" = 'scheduled' and "scheduled_at" <= ? order by "scheduled_at", "id" limit ${Math.min(Math.max(Math.trunc(limit), 1), 500)}`,
    [at],
  );
  const result: PublishDueResult = { published: [], blocked: [] };
  for (const row of due) {
    const entry: DueEntry = {
      id: String(row["id"]),
      siteId: String(row["site_id"]),
      type: String(row["type_key"]),
      slug: String(row["slug"]),
    };
    const authorId = String(row["author_id"]);
    const meta = (parseJson(row["meta"]) ?? {}) as Record<string, unknown>;
    const scheduler = typeof meta["scheduledBy"] === "string" ? meta["scheduledBy"] : "";
    const allowed =
      scheduler !== "" &&
      (await mayPublish({ siteId: entry.siteId, userId: scheduler, type: entry.type, authorId }));
    const status = allowed ? "published" : "draft";
    // The status check in the update is what makes this safe with two servers: only one of them gets the row.
    const claimed = await runner.transaction(async (tx) => {
      const got = await tx.all(
        `update "entries" set "status" = ?, "scheduled_at" = null,
                "published_at" = case when ? = 'published' then coalesce("published_at", ?) else "published_at" end,
                "revision" = "revision" + 1, "updated_at" = ?
          where "id" = ? and "status" = 'scheduled' returning "id"`,
        [status, status, at, at, entry.id],
      );
      if (got.length === 0) return false;
      await tx.all(
        `insert into "entry_revisions" ("id", "entry_id", "kind", "snapshot", "summary", "author_id", "created_at") values (?, ?, 'revision', ?, ?, ?, ?)`,
        [
          newId(),
          entry.id,
          JSON.stringify({
            title: String(row["title"]),
            slug: entry.slug,
            status,
            body: parseJson(row["body"]),
          }),
          allowed
            ? "Published on schedule"
            : "Not published: the person who scheduled it may no longer publish",
          // The copy belongs to the person who scheduled it, or to the author when that is not known.
          scheduler || authorId,
          at,
        ],
      );
      return true;
    });
    if (claimed) (allowed ? result.published : result.blocked).push(entry);
  }
  return result;
}
