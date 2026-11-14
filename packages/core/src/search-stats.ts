// Site search statistics (spec 08, section 16.3; SEO-75): popular searches and searches with no results, for the last
// 90 days. Only the words, the day and the counts are kept: no address, no time of day, no page, no session. Searches
// that look like an email address, a phone number or a long number are not recorded at all. So it needs no consent
// (ADR 0016).
import type { SqlRunner } from "@oks-page/db";

export const SEARCH_STATS_DAYS = 90;
const MOST_TERM = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The day of a moment, as "2026-11-14" (UTC). */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The words as they are kept: trimmed, single spaces, lower case, at most 100 characters. Null when the search must not be
 * kept: empty, or it looks like an email address, a phone number or a long number (seven digits or more in all).
 */
export function termToKeep(query: string): string | null {
  const term = query.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  if (!term) return null;
  if (term.includes("@")) return null;
  if ((term.match(/\p{Nd}/gu) ?? []).length >= 7) return null;
  return Array.from(term).slice(0, MOST_TERM).join("");
}

/** Counts one search. Nothing is kept when `termToKeep` says no. */
export async function recordSearch(
  runner: SqlRunner,
  siteId: string,
  query: string,
  found: boolean,
  now: () => number = Date.now,
): Promise<boolean> {
  const term = termToKeep(query);
  if (!term) return false;
  await runner.all(
    `insert into "search_terms" ("site_id", "term", "day", "searches", "no_results") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "term", "day") do update set "searches" = "search_terms"."searches" + 1,
       "no_results" = "search_terms"."no_results" + excluded."no_results"`,
    [siteId, term, dayOf(now()), found ? 0 : 1],
  );
  return true;
}

export interface SearchTermCount {
  term: string;
  searches: number;
  noResults: number;
}

export interface SearchStats {
  /** The first day counted. */
  since: string;
  total: number;
  popular: SearchTermCount[];
  noResults: SearchTermCount[];
}

const firstDay = (now: number) => dayOf(now - (SEARCH_STATS_DAYS - 1) * DAY_MS);

/** The most searched words and the words that found nothing, for the last 90 days. */
export async function loadSearchStats(
  runner: SqlRunner,
  siteId: string,
  now: () => number = Date.now,
  limit = 20,
): Promise<SearchStats> {
  const since = firstDay(now());
  const counts = async (order: string, having: string) =>
    (
      await runner.all(
        `select "term", sum("searches") as "s", sum("no_results") as "z" from "search_terms"
          where "site_id" = ? and "day" >= ? group by "term" ${having} order by ${order}, "term" limit ?`,
        [siteId, since, limit],
      )
    ).map((r) => ({
      term: String(r["term"]),
      searches: Number(r["s"]),
      noResults: Number(r["z"]),
    }));
  const total = await runner.all(
    `select coalesce(sum("searches"), 0) as "n" from "search_terms" where "site_id" = ? and "day" >= ?`,
    [siteId, since],
  );
  return {
    since,
    total: Number(total[0]?.["n"] ?? 0),
    popular: await counts(`sum("searches") desc`, ""),
    noResults: await counts(`sum("no_results") desc`, `having sum("no_results") > 0`),
  };
}

/** Deletes the counts older than 90 days, for every site. Returns how many rows went. */
export async function purgeSearchStats(
  runner: SqlRunner,
  now: () => number = Date.now,
): Promise<number> {
  const old = await runner.all(`select count(*) as "n" from "search_terms" where "day" < ?`, [
    firstDay(now()),
  ]);
  const n = Number(old[0]?.["n"] ?? 0);
  if (n > 0) await runner.all(`delete from "search_terms" where "day" < ?`, [firstDay(now())]);
  return n;
}
