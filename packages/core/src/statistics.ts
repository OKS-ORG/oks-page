// Visitor statistics (spec 18, section 3): page views, visitors, where they came from, country, device type and popular pages,
// counted without cookies and without keeping anyone's address.
//  - A visitor is a hash of their address and browser made with a secret that changes every day (a different secret for
//    each day and site, worked out from the site's own secret, never stored). The hash is only used to count a visitor once
//    a day; it is kept for that day alone and cannot be turned back into an address.
//  - The address is never stored: it is hashed in the same moment the page is asked for, and what is kept are daily totals.
//  - Browsers that say "do not track" (DNT or Global Privacy Control), robots, and prefetches are not counted.
import { createHmac } from "node:crypto";
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const STATISTICS_KEY = "statistics";

export type StatKind = "views" | "visitors" | "page" | "referrer" | "search" | "country" | "device";

export const DEVICES = ["desktop", "mobile", "tablet"] as const;
export type Device = (typeof DEVICES)[number];

/** One page view, already stripped of anything personal: the hash is the only trace of the visitor. */
export interface StatView {
  day: string;
  hash: string;
  /** The page's address ("/about"), without the query. */
  path: string;
  /** "search" or "referrer" with the key, or null for a visit that came straight to the site. */
  source: { kind: "search" | "referrer"; key: string } | null;
  /** Two capital letters, or "" when unknown. */
  country: string;
  device: Device;
}

/** The day as `YYYY-MM-DD` in UTC. */
export const statDayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The secret of one day for one site: it differs every day and is never stored (it is worked out from the site's secret). */
export function dailySecret(secret: string, siteId: string, day: string): string {
  return createHmac("sha256", secret).update(`statistics\n${siteId}\n${day}`).digest("hex");
}

/** The hash that stands for a visitor on one day. The same visitor has another hash the next day. */
export function visitorHash(daySecret: string, address: string, userAgent: string): string {
  return createHmac("sha256", daySecret)
    .update(`${address}\n${userAgent}`)
    .digest("hex")
    .slice(0, 32);
}

const BOT =
  /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|monitor|uptime|lighthouse|headless|curl|wget|python-requests|httpclient|axios|node-fetch|go-http|java\//i;

/** True for browsers that are not people: robots, crawlers, link checkers and command-line tools. */
export const isBot = (userAgent: string): boolean => userAgent.trim() === "" || BOT.test(userAgent);

/** The kind of device, from the browser's own words. */
export function deviceOf(userAgent: string): Device {
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(userAgent)) return "tablet";
  if (/mobi|iphone|ipod|android|windows phone/i.test(userAgent)) return "mobile";
  return "desktop";
}

const ENGINES: [RegExp, string][] = [
  [/(^|\.)google\./, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)ecosia\.org$/, "Ecosia"],
  [/(^|\.)search\.yahoo\.com$|(^|\.)yahoo\.com$/, "Yahoo"],
  [/(^|\.)baidu\.com$/, "Baidu"],
  [/(^|\.)yandex\./, "Yandex"],
  [/(^|\.)qwant\.com$/, "Qwant"],
  [/(^|\.)startpage\.com$/, "Startpage"],
  [/(^|\.)brave\.com$/, "Brave Search"],
];

/**
 * Where a visit came from: a search engine, another site, or null (straight to the site, or from the site itself). Only the
 * host is kept, never the address or the words that were searched for.
 */
export function sourceOf(referer: string | null | undefined, ownHost: string): StatView["source"] {
  if (!referer) return null;
  let host: string;
  try {
    const u = new URL(referer);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  const own = ownHost
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
  if (host === "" || host === own) return null;
  const engine = ENGINES.find(([re]) => re.test(host));
  if (engine) return { kind: "search", key: engine[1] };
  return { kind: "referrer", key: host.slice(0, 100) };
}

/** The country code a host or CDN put in a header, or "" (the site has no list of addresses of its own). */
export function countryOf(read: (name: string) => string | null): string {
  for (const name of [
    "cf-ipcountry",
    "x-vercel-ip-country",
    "cloudfront-viewer-country",
    "x-country-code",
  ]) {
    const v = read(name)?.trim().toUpperCase() ?? "";
    if (/^[A-Z]{2}$/.test(v) && v !== "XX" && v !== "T1") return v;
  }
  return "";
}

export interface Reading {
  /** The statistics setting is on. */
  enabled: boolean;
}

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string };

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** Is counting on? It is on unless the owner switched it off. */
export async function statisticsEnabled(runner: SqlRunner, siteId: string): Promise<boolean> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, STATISTICS_KEY],
  );
  const v = decode(runner, rows[0]?.["value"]) as { enabled?: unknown } | null;
  return v?.enabled !== false;
}

/** Switches counting on or off. Only people who manage the settings. */
export async function saveStatisticsEnabled(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  enabled: unknown,
): Promise<{ ok: true; enabled: boolean } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (typeof enabled !== "boolean")
    return { ok: false, code: "invalid", message: "Choose on or off." };
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, STATISTICS_KEY, JSON.stringify({ enabled }), new Date()],
  );
  return { ok: true, enabled };
}

/**
 * Adds page views to the daily totals. A view is a view of its page and, when the visitor is new for that day (their hash
 * was not seen that day), a visitor and one count for their source, country and device. Safe to call with any number of
 * views; each is counted once.
 */
export async function recordViews(
  runner: SqlRunner,
  siteId: string,
  views: StatView[],
): Promise<void> {
  const add = new Map<string, number>();
  const bump = (day: string, kind: StatKind, key: string, by = 1) => {
    const id = `${day}\u0000${kind}\u0000${key}`;
    add.set(id, (add.get(id) ?? 0) + by);
  };
  for (const v of views) {
    bump(v.day, "views", "");
    bump(v.day, "page", v.path);
    const fresh = await runner.all(
      `insert into "stats_seen" ("site_id", "day", "hash") values (?, ?, ?) on conflict do nothing returning "hash"`,
      [siteId, v.day, v.hash],
    );
    if (fresh.length === 0) continue;
    bump(v.day, "visitors", "");
    if (v.source) bump(v.day, v.source.kind, v.source.key);
    if (v.country) bump(v.day, "country", v.country);
    bump(v.day, "device", v.device);
  }
  for (const [id, by] of add) {
    const [day, kind, key] = id.split("\u0000") as [string, string, string];
    await runner.all(
      `insert into "stats_daily" ("site_id", "day", "kind", "key", "count") values (?, ?, ?, ?, ?)
       on conflict ("site_id", "day", "kind", "key") do update set "count" = "stats_daily"."count" + excluded."count"`,
      [siteId, day, kind, key, by],
    );
  }
}

export interface StatRow {
  key: string;
  count: number;
}

export interface Statistics {
  /** Days the report covers, newest last (every day of the range, 0 when nothing was counted). */
  days: { day: string; views: number; visitors: number }[];
  views: number;
  /** Visitors added up over the days: a visitor who came on two days counts twice (nobody can be followed from day to day). */
  visitors: number;
  pages: StatRow[];
  referrers: StatRow[];
  searches: StatRow[];
  countries: StatRow[];
  devices: StatRow[];
}

const TOP = 10;

/** The totals of the last `days` days, today included. */
export async function loadStatistics(
  runner: SqlRunner,
  siteId: string,
  days: number,
  now: number = Date.now(),
): Promise<Statistics> {
  const whole = Math.trunc(days);
  const range = whole >= 1 ? Math.min(whole, 730) : 7;
  const first = statDayOf(now - (range - 1) * 24 * 60 * 60 * 1000);
  const rows = await runner.all(
    `select "day", "kind", "key", "count" from "stats_daily" where "site_id" = ? and "day" >= ?`,
    [siteId, first],
  );
  const per = new Map<string, { views: number; visitors: number }>();
  for (let i = range - 1; i >= 0; i--)
    per.set(statDayOf(now - i * 24 * 60 * 60 * 1000), { views: 0, visitors: 0 });
  const sums: Record<"page" | "referrer" | "search" | "country" | "device", Map<string, number>> = {
    page: new Map(),
    referrer: new Map(),
    search: new Map(),
    country: new Map(),
    device: new Map(),
  };
  let views = 0;
  let visitors = 0;
  for (const r of rows) {
    const day = String(r["day"]);
    const kind = String(r["kind"]);
    const key = String(r["key"]);
    const n = Number(r["count"]);
    const d = per.get(day);
    if (kind === "views") {
      views += n;
      if (d) d.views += n;
    } else if (kind === "visitors") {
      visitors += n;
      if (d) d.visitors += n;
    } else if (kind in sums) {
      const m = sums[kind as keyof typeof sums];
      m.set(key, (m.get(key) ?? 0) + n);
    }
  }
  const top = (m: Map<string, number>, most = TOP): StatRow[] =>
    [...m]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, most);
  return {
    days: [...per].map(([day, v]) => ({ day, ...v })),
    views,
    visitors,
    pages: top(sums.page),
    referrers: top(sums.referrer),
    searches: top(sums.search),
    countries: top(sums.country),
    devices: top(sums.device, 3),
  };
}
