// What the dashboard shows (spec 07, "Home"): counts of the site's content and the latest edits.
import { getRunner } from "./db";

export interface DashboardData {
  siteName: string;
  /** Published pages, published posts, and entries still in draft (any type). */
  counts: { pages: number; posts: number; drafts: number };
  recent: { title: string; type: string; status: string; updatedAt: string }[];
}

const toIso = (value: unknown): string =>
  (value instanceof Date ? value : new Date(Number(value))).toISOString();

export async function loadDashboard(siteId: string): Promise<DashboardData> {
  const runner = getRunner();
  const site = (await runner.all(`select "name" from "sites" where "id" = ?`, [siteId]))[0];
  const groups = await runner.all(
    `select "type_key", "status", count(*) as n from "entries"
      where "site_id" = ? and "status" <> 'trash' group by "type_key", "status"`,
    [siteId],
  );
  const counts = { pages: 0, posts: 0, drafts: 0 };
  for (const row of groups) {
    const n = Number(row["n"]); // PostgreSQL returns a count as text
    if (row["status"] === "draft") counts.drafts += n;
    else if (row["status"] === "published" && row["type_key"] === "page") counts.pages += n;
    else if (row["status"] === "published" && row["type_key"] === "post") counts.posts += n;
  }
  const recent = await runner.all(
    `select "title", "type_key", "status", "updated_at" from "entries"
      where "site_id" = ? and "status" <> 'trash' order by "updated_at" desc, "id" limit 5`,
    [siteId],
  );
  return {
    siteName: String(site?.["name"] ?? ""),
    counts,
    recent: recent.map((row) => ({
      title: String(row["title"]),
      type: String(row["type_key"]),
      status: String(row["status"]),
      updatedAt: toIso(row["updated_at"]),
    })),
  };
}
