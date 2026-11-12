// Site settings the proxy needs on every request, read at most once per few seconds in each process.
import {
  MAINTENANCE_SETTINGS_KEY,
  readMaintenanceSettings,
  type MaintenanceSettings,
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

/** The "I use a CDN" setting (decision D81). Off unless the owner turns it on. */
export async function cdnEnabled(): Promise<boolean> {
  const v = (await readSetting("cdn")) as { enabled?: boolean } | null;
  return v?.enabled === true;
}
