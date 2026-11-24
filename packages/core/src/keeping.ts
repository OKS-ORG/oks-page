// How long personal data is kept (spec 18, section 6; PR-08). Each kind has a time the site keeps it for by default, and the
// owner may make it shorter (never longer). A job once a day deletes what is older. Form messages are kept by the Forms
// plugin (12 months by default, set in its own settings), and posts in the trash are emptied after 30 days (spec 03); the
// rest of the table of spec 18 is not kept by the site yet (statistics, consent records, comment address hashes).
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const KEEPING_KEY = "keeping";
export const KEEPING_LAST_KEY = "keeping_last_run";
const DAY = 24 * 60 * 60 * 1000;

export type KeepingId =
  "email_log" | "audit_log" | "search_terms" | "consent_records" | "statistics";

export interface KeepingRule {
  id: KeepingId;
  label: string;
  /** What is kept, in plain words. */
  what: string;
  /** The time the site keeps it for unless the owner chooses a shorter one. */
  defaultDays: number;
  /** The shortest time the owner may choose. */
  leastDays: number;
}

export const KEEPING_RULES: KeepingRule[] = [
  {
    id: "email_log",
    label: "Record of emails sent",
    what: "Who an email was sent to, its subject and whether it arrived. The text of an email is never kept.",
    defaultDays: 30,
    leastDays: 1,
  },
  {
    id: "audit_log",
    label: "Audit log",
    what: "Who did what in the admin, and each privacy request (as a hash of the address, never the address).",
    defaultDays: 365,
    leastDays: 30,
  },
  {
    id: "search_terms",
    label: "Site search counts",
    what: "What visitors searched for, counted by day. Nothing in it points to a person.",
    defaultDays: 90,
    leastDays: 7,
  },
  {
    id: "consent_records",
    label: "Consent records",
    what: "What visitors chose in the consent notice, and when, as proof that they were asked. Nothing in it points to a person.",
    defaultDays: 365,
    leastDays: 30,
  },
  {
    id: "statistics",
    label: "Visitor statistics",
    what: "Daily totals of page views and visitors, by page, source, country and device type. Nothing in it points to a person.",
    defaultDays: 730,
    leastDays: 30,
  },
];

export type KeepingDays = Record<KeepingId, number>;

export interface KeepingView {
  /** The days in force for each kind. */
  days: KeepingDays;
  /** True for the kinds the owner made shorter. */
  shortened: Record<KeepingId, boolean>;
  lastRun: { at: number; deleted: Record<KeepingId, number> } | null;
}

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

async function read(runner: SqlRunner, siteId: string, key: string): Promise<unknown> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  return decode(runner, rows[0]?.["value"]);
}

async function write(
  runner: SqlRunner,
  siteId: string,
  key: string,
  value: unknown,
  at: number,
): Promise<void> {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date(at)],
  );
}

/** The days in force: the owner's shorter time where it is sound, else the default. A longer or nonsense value is ignored. */
function effective(stored: unknown): { days: KeepingDays; shortened: Record<KeepingId, boolean> } {
  const chosen =
    stored !== null && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const days = {} as KeepingDays;
  const shortened = {} as Record<KeepingId, boolean>;
  for (const r of KEEPING_RULES) {
    const v = chosen[r.id];
    const ok =
      typeof v === "number" && Number.isInteger(v) && v >= r.leastDays && v < r.defaultDays;
    days[r.id] = ok ? (v as number) : r.defaultDays;
    shortened[r.id] = ok;
  }
  return { days, shortened };
}

export async function loadKeeping(runner: SqlRunner, siteId: string): Promise<KeepingView> {
  const { days, shortened } = effective(await read(runner, siteId, KEEPING_KEY));
  const last = (await read(runner, siteId, KEEPING_LAST_KEY)) as {
    at?: unknown;
    deleted?: Record<string, unknown>;
  } | null;
  const lastRun =
    last && typeof last.at === "number"
      ? {
          at: last.at,
          deleted: Object.fromEntries(
            KEEPING_RULES.map((r) => [r.id, Number(last.deleted?.[r.id] ?? 0)]),
          ) as Record<KeepingId, number>,
        }
      : null;
  return { days, shortened, lastRun };
}

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

/**
 * Saves the owner's times. A kind that is left out, or given its default, keeps the default. Each must be a whole number of
 * days from the shortest allowed up to the default; a longer time is refused (a default is a limit, not a floor).
 */
export async function saveKeeping(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: unknown,
  now: () => number = Date.now,
): Promise<{ ok: true; keeping: KeepingView } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { ok: false, code: "invalid", message: "The request was not understood." };
  const given = input as Record<string, unknown>;
  const unknown = Object.keys(given).find((k) => !KEEPING_RULES.some((r) => r.id === k));
  if (unknown)
    return {
      ok: false,
      code: "invalid",
      message: "This is not something the site keeps for a time.",
      field: unknown,
    };
  const out: Partial<Record<KeepingId, number>> = {};
  for (const r of KEEPING_RULES) {
    const v = given[r.id];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < r.leastDays || n > r.defaultDays)
      return {
        ok: false,
        code: "invalid",
        message: `${r.label}: choose a number of days from ${r.leastDays} to ${r.defaultDays}.`,
        field: r.id,
      };
    if (n < r.defaultDays) out[r.id] = n;
  }
  await write(runner, siteId, KEEPING_KEY, out, now());
  return { ok: true, keeping: await loadKeeping(runner, siteId) };
}

/** Deletes the lines of the record of emails that are older than `days`. */
export async function purgeEmailLog(
  runner: SqlRunner,
  siteId: string,
  days: number,
  now: () => number,
): Promise<number> {
  const gone = await runner.all(
    `delete from "email_log" where "site_id" = ? and "created_at" < ? returning "id"`,
    [siteId, new Date(now() - days * DAY)],
  );
  return gone.length;
}

/** Deletes the lines of the audit log that are older than `days`. */
export async function purgeAuditLog(
  runner: SqlRunner,
  siteId: string,
  days: number,
  now: () => number,
): Promise<number> {
  const gone = await runner.all(
    `delete from "audit_log" where "site_id" = ? and "created_at" < ? returning "id"`,
    [siteId, new Date(now() - days * DAY)],
  );
  return gone.length;
}

/** Deletes the consent records that are older than `days`. */
export async function purgeConsentRecords(
  runner: SqlRunner,
  siteId: string,
  days: number,
  now: () => number,
): Promise<number> {
  const gone = await runner.all(
    `delete from "consent_records" where "site_id" = ? and "created_at" < ? returning "id"`,
    [siteId, new Date(now() - days * DAY)],
  );
  return gone.length;
}

/** Deletes the daily statistics of days before the last `days` days (today counts as the first). */
export async function purgeStatistics(
  runner: SqlRunner,
  siteId: string,
  days: number,
  now: () => number,
): Promise<number> {
  const first = dayText(now() - (days - 1) * DAY);
  const gone = await runner.all(
    `delete from "stats_daily" where "site_id" = ? and "day" < ? returning "day"`,
    [siteId, first],
  );
  // The marks of who was counted are only needed for the day itself; yesterday's go too.
  await runner.all(`delete from "stats_seen" where "site_id" = ? and "day" < ?`, [
    siteId,
    dayText(now()),
  ]);
  return gone.length;
}

/** The day (`YYYY-MM-DD`, UTC) a count must be from to be kept: counts older than `days` days go. */
const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Deletes the search counts of days before the last `days` days (today counts as the first). */
export async function purgeSearchCounts(
  runner: SqlRunner,
  siteId: string,
  days: number,
  now: () => number,
): Promise<number> {
  const first = dayText(now() - (days - 1) * DAY);
  const gone = await runner.all(
    `delete from "search_terms" where "site_id" = ? and "day" < ? returning "term"`,
    [siteId, first],
  );
  return gone.length;
}

export type KeepingRun = { sites: number; deleted: Record<KeepingId, number> };

/**
 * Deletes what is past its keeping time, for every site, with the times in force for each. It writes down when it ran and
 * how much it deleted (counts only), for Settings > Privacy to show. It is safe to run again at any time.
 */
export async function runKeeping(
  runner: SqlRunner,
  now: () => number = Date.now,
): Promise<KeepingRun> {
  const total: Record<KeepingId, number> = {
    email_log: 0,
    audit_log: 0,
    search_terms: 0,
    consent_records: 0,
    statistics: 0,
  };
  const sites = await runner.all(`select "id" from "sites"`);
  for (const s of sites) {
    const siteId = String(s["id"]);
    const { days } = effective(await read(runner, siteId, KEEPING_KEY));
    const deleted: Record<KeepingId, number> = {
      email_log: await purgeEmailLog(runner, siteId, days.email_log, now),
      audit_log: await purgeAuditLog(runner, siteId, days.audit_log, now),
      search_terms: await purgeSearchCounts(runner, siteId, days.search_terms, now),
      consent_records: await purgeConsentRecords(runner, siteId, days.consent_records, now),
      statistics: await purgeStatistics(runner, siteId, days.statistics, now),
    };
    for (const r of KEEPING_RULES) total[r.id] += deleted[r.id];
    await write(runner, siteId, KEEPING_LAST_KEY, { at: now(), deleted }, now());
  }
  return { sites: sites.length, deleted: total };
}
