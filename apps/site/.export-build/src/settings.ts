// Site settings the proxy needs on every request, read at most once per few seconds in each process.
import { getRunner, getSiteId } from "./db";

const TTL_MS = Number(process.env["OKS_SETTINGS_TTL_MS"] ?? 5000);
const cache = new Map<string, { value: unknown; at: number }>();

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

/** The "I use a CDN" setting (decision D81). Off unless the owner turns it on. */
export async function cdnEnabled(): Promise<boolean> {
  const v = (await readSetting("cdn")) as { enabled?: boolean } | null;
  return v?.enabled === true;
}
