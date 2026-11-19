// What the dashboard shows (spec 07, "Home"): counts of the site's content and the latest edits.
import { emailHealth, emailWorks, loadGeneralSettings } from "@oks-page/core";
import { getRunner } from "./db";

export interface DashboardData {
  siteName: string;
  /** The site's time zone, or null when it is automatic (each person's own browser). */
  timeZone: string | null;
  /** Published pages, published posts, and entries still in draft (any type). */
  counts: { pages: number; posts: number; drafts: number; waiting: number };
  recent: { id: string; title: string; type: string; status: string; updatedAt: string }[];
  /** False while email is not set up (spec 13, section 3: the dashboard says so). */
  emailWorks: boolean;
  /** Set when emails keep failing (spec 13, section 7: the dashboard says so). */
  emailProblem: string | null;
}

const toIso = (value: unknown): string =>
  (value instanceof Date ? value : new Date(Number(value))).toISOString();

export async function loadDashboard(siteId: string): Promise<DashboardData> {
  const runner = getRunner();
  const general = await loadGeneralSettings(runner, siteId);
  const groups = await runner.all(
    `select "type_key", "status", count(*) as n from "entries"
      where "site_id" = ? and "status" <> 'trash' group by "type_key", "status"`,
    [siteId],
  );
  const counts = { pages: 0, posts: 0, drafts: 0, waiting: 0 };
  for (const row of groups) {
    const n = Number(row["n"]); // PostgreSQL returns a count as text
    if (row["status"] === "draft") counts.drafts += n;
    else if (row["status"] === "pending") counts.waiting += n;
    else if (row["status"] === "published" && row["type_key"] === "page") counts.pages += n;
    else if (row["status"] === "published" && row["type_key"] === "post") counts.posts += n;
  }
  const recent = await runner.all(
    `select "id", "title", "type_key", "status", "updated_at" from "entries"
      where "site_id" = ? and "status" <> 'trash' order by "updated_at" desc, "id" limit 5`,
    [siteId],
  );
  const health = await emailHealth(runner, siteId);
  return {
    siteName: general.siteName,
    timeZone: general.timeZone,
    emailWorks: await emailWorks(runner, siteId),
    emailProblem: health.problem ? health.message : null,
    counts,
    recent: recent.map((row) => ({
      id: String(row["id"]),
      title: String(row["title"]),
      type: String(row["type_key"]),
      status: String(row["status"]),
      updatedAt: toIso(row["updated_at"]),
    })),
  };
}
