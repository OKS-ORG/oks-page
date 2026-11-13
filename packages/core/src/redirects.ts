// Redirects (spec 08, section 5). When a published page or post gets a new address, a 301 from the old address to the
// new one is added by itself, so old links and search results keep working. The owner can also add and remove
// redirects by hand. A chain is always collapsed to one step (a→b then b→c gives a→c and b→c), and a redirect that
// would make a loop, or point to itself, is refused.
import { newId, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export const REDIRECT_PATH_MAX = 500;

export interface RedirectView {
  id: string;
  from: string;
  to: string;
  status: number;
  hits: number;
  createdAt: number;
}

export type RedirectResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };

const fail = (code: "forbidden" | "invalid" | "not_found", message: string) =>
  ({ ok: false, code, message }) as const;

const time = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

/** The address path of an entry slug: "home" is the front page. */
export const pathOfSlug = (slug: string): string => (slug === "home" ? "/" : `/${slug}`);

/** Parts of the site that are not content: nothing may be redirected from them. */
const SYSTEM = /^\/(admin|api|_next|uploads|search|sitemap\.xml|robots\.txt|favicon\.ico)(\/|$)/;
const FROM = /^\/(?!\/)[^\s?#]*$/;
const TO = /^(\/(?!\/)[^\s]*|https?:\/\/[^\s]+)$/i;

/**
 * A path as stored: leading slash, no trailing slash (except the front page "/"), and in the composed Unicode form (NFC)
 * that addresses are stored in, so "/café" typed in the decomposed form is the same address.
 */
export function cleanPath(path: string): string {
  const trimmed = path.trim().normalize("NFC");
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") || "/" : trimmed;
}

const isInternal = (path: string) => path.startsWith("/");

async function target(runner: SqlRunner, siteId: string, from: string): Promise<string | null> {
  const rows = await runner.all(
    `select "to_path" from "redirects" where "site_id" = ? and "from_path" = ?`,
    [siteId, from],
  );
  return rows[0] ? String(rows[0]["to_path"]) : null;
}

/**
 * Follows the chain from an address. Returns where it ends, or "loop" when it comes back to `back` (or goes round in a
 * circle). An external address ends the chain.
 */
async function endOf(
  runner: SqlRunner,
  siteId: string,
  start: string,
  back: string,
): Promise<string | "loop"> {
  let at = start;
  const seen = new Set<string>();
  while (isInternal(at)) {
    if (at === back || seen.has(at)) return "loop";
    seen.add(at);
    const next = await target(runner, siteId, at);
    if (next === null) return at;
    at = next;
  }
  return at;
}

/** Stores from→to as one step, and points everything that led to `from` at the same place. */
async function store(
  runner: SqlRunner,
  siteId: string,
  from: string,
  to: string,
  status: number,
): Promise<void> {
  await runner.transaction(async (tx) => {
    // Nothing may redirect away from the address that now leads somewhere live.
    await tx.all(`delete from "redirects" where "site_id" = ? and "from_path" = ?`, [siteId, to]);
    await tx.all(`update "redirects" set "to_path" = ? where "site_id" = ? and "to_path" = ?`, [
      to,
      siteId,
      from,
    ]);
    await tx.all(
      `insert into "redirects" ("id", "site_id", "from_path", "to_path", "status_code", "hit_count", "created_at")
       values (?, ?, ?, ?, ?, 0, ?)
       on conflict ("site_id", "from_path") do update set "to_path" = excluded."to_path", "status_code" = excluded."status_code"`,
      [newId(), siteId, from, to, status, new Date()],
    );
  });
}

/**
 * Called when a published entry gets a new address: old → new as a 301, chains collapsed. The old front page address
 * ("/") is never redirected. Safe to call again with the same values.
 */
export async function recordSlugChange(
  runner: SqlRunner,
  siteId: string,
  oldSlug: string,
  newSlug: string,
): Promise<void> {
  const from = pathOfSlug(oldSlug);
  const to = pathOfSlug(newSlug);
  if (from === "/" || from === to) return;
  await store(runner, siteId, from, to, 301);
}

export interface RedirectInput {
  from: string;
  to: string;
  status?: number;
}

/** Adds (or changes) a redirect by hand. Needs `settings.manage`. */
export async function addRedirect(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: RedirectInput,
): Promise<RedirectResult<{ from: string; to: string }>> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not change the redirects.");
  const from = cleanPath(String(input.from ?? ""));
  let to = String(input.to ?? "").trim();
  if (isInternal(to)) to = cleanPath(to);
  const status = input.status ?? 301;
  if (!(REDIRECT_STATUSES as readonly number[]).includes(status))
    return fail("invalid", "The kind of redirect must be 301, 302, 307 or 308.");
  if (!FROM.test(from) || from.length > REDIRECT_PATH_MAX)
    return fail("invalid", "The old address must start with / and have no spaces, ? or #.");
  if (from === "/") return fail("invalid", "The front page cannot be redirected.");
  if (SYSTEM.test(from)) return fail("invalid", "That part of the site cannot be redirected.");
  if (!TO.test(to) || to.length > REDIRECT_PATH_MAX)
    return fail("invalid", "The new address must start with / or https:// and have no spaces.");
  if (to === from) return fail("invalid", "A redirect cannot point to itself.");
  const live = await runner.all(
    `select 1 as found from "entries" where "site_id" = ? and "status" = 'published' and "locale" = '' and "slug" = ? limit 1`,
    [siteId, from === "/" ? "home" : from.slice(1)],
  );
  if (live.length > 0)
    return fail("invalid", "A page already uses this address, so it cannot be redirected.");
  // Where does the new address end up? If it leads back here, this would make a loop.
  const end = isInternal(to) ? await endOf(runner, siteId, to, from) : to;
  if (end === "loop") return fail("invalid", "This would make a loop.");
  await store(runner, siteId, from, end, status);
  return { ok: true, from, to: end };
}

export async function listRedirects(runner: SqlRunner, siteId: string): Promise<RedirectView[]> {
  const rows = await runner.all(
    `select "id", "from_path", "to_path", "status_code", "hit_count", "created_at" from "redirects"
      where "site_id" = ? order by "created_at" desc, "from_path"`,
    [siteId],
  );
  return rows.map((r) => ({
    id: String(r["id"]),
    from: String(r["from_path"]),
    to: String(r["to_path"]),
    status: Number(r["status_code"]),
    hits: Number(r["hit_count"]),
    createdAt: time(r["created_at"]),
  }));
}

export async function deleteRedirect(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<RedirectResult<Record<never, never>>> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not change the redirects.");
  const gone = await runner.all(
    `delete from "redirects" where "id" = ? and "site_id" = ? returning "id"`,
    [id, siteId],
  );
  return gone.length === 0 ? fail("not_found", "There is no such redirect.") : { ok: true };
}

/** What the proxy asks for an address that is not a page: is there a redirect from it? */
export async function findRedirect(
  runner: SqlRunner,
  siteId: string,
  path: string,
): Promise<{ id: string; to: string; status: number } | null> {
  const rows = await runner.all(
    `select "id", "to_path", "status_code" from "redirects" where "site_id" = ? and "from_path" = ?`,
    [siteId, path],
  );
  return rows[0]
    ? {
        id: String(rows[0]["id"]),
        to: String(rows[0]["to_path"]),
        status: Number(rows[0]["status_code"]),
      }
    : null;
}

/** Counts one use of a redirect. */
export async function countRedirectHit(runner: SqlRunner, id: string): Promise<void> {
  await runner.all(`update "redirects" set "hit_count" = "hit_count" + 1 where "id" = ?`, [id]);
}
