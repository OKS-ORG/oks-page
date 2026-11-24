// The business the Business plugin describes (spec 19, section 3), read from the plugin's saved settings while the plugin is
// switched on. The site reads it for the LocalBusiness structured data of every page; the plugin itself never sees a visitor.
import { BUSINESS_PLUGIN_ID, ratingOf, readBusiness, type BusinessInfo } from "@oks-page/core";
import type { SqlRunner } from "@oks-page/db";

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** The business, or null when the plugin is not installed, is switched off, or has no business name. */
export async function loadBusinessInfo(
  runner: SqlRunner,
  siteId: string,
): Promise<BusinessInfo | null> {
  const found = await runner.all(
    `select "id" from "extensions" where "site_id" = ? and "kind" = 'plugin' and "key" = ? and "status" = 'enabled'`,
    [siteId, BUSINESS_PLUGIN_ID],
  );
  if (found.length === 0) return null;
  const rows = await runner.all(
    `select "key", "value" from "extension_settings" where "extension_id" = ? and "is_secret" = ?`,
    [String(found[0]!["id"]), false],
  );
  const values: Record<string, unknown> = {};
  for (const r of rows) values[String(r["key"])] = decode(runner, r["value"]);
  const business = readBusiness(values);
  if (!business) return null;
  // The rating of the reviews collected on the site and approved (the latest 1,000 are read).
  const reviews = await runner.all(
    `select "value" from "extension_storage" where "extension_id" = ? and "collection" = 'reviews' order by "key" desc limit 1000`,
    [String(found[0]!["id"])],
  );
  const rating = ratingOf(reviews.map((r) => decode(runner, r["value"])));
  return rating ? { ...business, rating } : business;
}
