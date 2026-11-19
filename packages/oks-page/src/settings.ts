// Site settings the proxy needs on every request, read at most once per few seconds in each process.
import {
  loadReadingRoutes,
  type ReadingRoutes,
  READING_SETTINGS_KEY,
  readReadingSettings,
  type ReadingSettings,
  MAINTENANCE_SETTINGS_KEY,
  SEO_SETTINGS_KEY,
  readMaintenanceSettings,
  readSeoSettings,
  readSecuritySettings,
  SECURITY_SETTINGS_KEY,
  type MaintenanceSettings,
  type SeoSettings,
} from "@oks-page/core";
import { getRunner, getSiteId } from "./db";

const TTL_MS = Number(process.env["OKS_SETTINGS_TTL_MS"] ?? 5000);
// On globalThis like the database connection: the proxy and the pages are separate bundles in one process.
const shared = globalThis as typeof globalThis & {
  __oksSettings?: Map<string, { value: unknown; at: number }>;
};
const cache = (shared.__oksSettings ??= new Map());

async function readSetting(key: string): Promise<unknown> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const rows = await getRunner().all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [await getSiteId(), key],
  );
  let value: unknown = null;
  if (rows[0]) {
    const raw = rows[0]["value"];
    value = typeof raw === "string" ? JSON.parse(raw) : raw; // SQLite keeps JSON as text; PostgreSQL's driver has parsed it
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

/**
 * Makes this process read a setting again at the next request. Used right after the settings screen saves one, so the
 * change is live here at once; other server processes pick it up within the few seconds of the cache.
 */
export function forgetSetting(key: string): void {
  cache.delete(key);
}

/** Maintenance mode (on or off, and the message for visitors). Off unless the owner turns it on. */
export async function maintenanceSettings(): Promise<MaintenanceSettings> {
  return readMaintenanceSettings(await readSetting(MAINTENANCE_SETTINGS_KEY));
}

/** Whether the owner asked search engines to stay away (robots.txt, the sitemap and a `noindex` header). Off by default. */
export async function seoSettings(): Promise<SeoSettings> {
  return readSeoSettings(await readSetting(SEO_SETTINGS_KEY));
}

/** Settings > Reading (the feeds read whether to carry the whole text). */
export async function readingSettings(): Promise<ReadingSettings> {
  return readReadingSettings(await readSetting(READING_SETTINGS_KEY));
}

/**
 * Where the home page and the posts page are (Settings > Reading), for the proxy: "/" is a page even when the site has
 * no page at "home", and the chosen home page's own address leads to "/". Kept for the same few seconds as a setting.
 */
export async function readingRoutes(): Promise<ReadingRoutes> {
  const hit = cache.get("reading-routes");
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as ReadingRoutes;
  const value = await loadReadingRoutes(getRunner(), await getSiteId());
  cache.set("reading-routes", { value, at: Date.now() });
  return value;
}

/** The extra hosts public pages may load stylesheets from (Settings > Security, TH-49). Usually none. */
export async function styleHosts(): Promise<string[]> {
  return readSecuritySettings(await readSetting(SECURITY_SETTINGS_KEY)).styleHosts;
}

/** The "I use a CDN" setting (decision D81). Off unless the owner turns it on. */
export async function cdnEnabled(): Promise<boolean> {
  const v = (await readSetting("cdn")) as { enabled?: boolean } | null;
  return v?.enabled === true;
}
