// The agency dashboard (spec 11, section 6; AG-01 to AG-15, AG-83): the agency's own install keeps a list of client sites. Each is
// connected with a connection code made on that site, and answers signed requests (see connector.ts). The dashboard asks every site
// for its status, all at once, with a time limit for each site and for the whole round, so one site that is down never holds up
// the others. Adding a site needs an Agency key and room under its site count; seeing the last known state does not.
import type { SqlRunner } from "@oks-page/db";
import { newId } from "@oks-page/db";
import type { Actor } from "./content.js";
import {
  parseConnectionCode,
  signRequest,
  type ConnectorReport,
  type ConnectorStatus,
} from "./connector.js";
import type { SiteSecrets } from "./secret-box.js";
import type { LicencePayload } from "./licence.js";
import { bestLicenceState } from "./licence.js";
import { AGENCY_ITEM } from "./white-label.js";

export const AGENCY_SITES_KEY = "agency_sites";
export const AGENCY_SITE_NAME_MAX = 80;
const RESPONSE_MAX_CHARS = 256 * 1024;

/** How many client sites the Agency keys of this install are sold for (only keys that still let the paid features run). */
export function agencySiteLimit(
  licences: readonly LicencePayload[],
  host: string,
  now: Date,
): number {
  return licences
    .filter((l) => l.covers.includes(AGENCY_ITEM))
    .filter((l) => bestLicenceState([l], { item: AGENCY_ITEM, host, now })?.paidFeatures === true)
    .reduce((n, l) => n + l.sites, 0);
}

const isLoopback = (host: string): boolean =>
  host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";

const PRIVATE = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** The address of a client site: https (http only for this machine's own addresses), no password in it, nothing private. */
export function checkSiteUrl(
  input: string,
): { ok: true; url: string } | { ok: false; message: string } {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, message: "The site's address in the code is not an address." };
  }
  if (u.username || u.password)
    return { ok: false, message: "The site's address must not hold a name or password." };
  if (u.protocol === "http:" && !isLoopback(u.hostname))
    return {
      ok: false,
      message: "The site's address must start with https:// (a secure connection).",
    };
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { ok: false, message: "The site's address must start with https://." };
  if (!isLoopback(u.hostname) && PRIVATE.some((r) => r.test(u.hostname)))
    return {
      ok: false,
      message: "The site's address points inside a private network, which is not allowed.",
    };
  u.hash = "";
  u.search = "";
  return { ok: true, url: u.toString().replace(/\/$/, "") };
}

// What a client site says is read as untrusted: every value is checked and cut to size before it is kept or shown, so a site that
// answers with something odd (or hostile) cannot fill the dashboard's settings or put markup in a report.
const text = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, max)
    : "";
const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.trunc(v), 1e12) : 0;
const orNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.trunc(v), 1e15) : null;
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

export function cleanStatus(data: unknown): ConnectorStatus | null {
  const d = obj(data);
  if (d["ok"] !== true) return null;
  return {
    version: text(d["version"], 40),
    siteName: text(d["siteName"], 120),
    pendingUpdates: orNull(d["pendingUpdates"]),
    lastBackupAt: orNull(d["lastBackupAt"]),
    diskFreeBytes: orNull(d["diskFreeBytes"]),
    checks: list(d["checks"], 20).map((c) => ({
      id: text(obj(c)["id"], 40),
      label: text(obj(c)["label"], 120),
      ok: obj(c)["ok"] === true,
    })),
    at: orNull(d["at"]) ?? 0,
  };
}

export function cleanReport(data: unknown): ConnectorReport | null {
  const d = obj(data);
  if (d["ok"] !== true) return null;
  const days = Math.min(Math.max(count(d["days"]), 1), 90);
  return {
    days,
    views: count(d["views"]),
    visitors: count(d["visitors"]),
    publishedPages: count(d["publishedPages"]),
    topPages: list(d["topPages"], 10).map((p) => ({
      key: text(obj(p)["key"], 200),
      count: count(obj(p)["count"]),
    })),
    perDay: list(d["perDay"], 90)
      .map((p) => ({
        day: text(obj(p)["day"], 10),
        views: count(obj(p)["views"]),
        visitors: count(obj(p)["visitors"]),
      }))
      .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.day)),
  };
}

export interface SiteCheck {
  at: number;
  ok: boolean;
  status?: ConnectorStatus;
  /** What went wrong, in words. */
  error?: string;
  code?: "unreachable" | "clock" | "refused" | "missing" | "not_available" | "failed" | "late";
}

interface StoredSite {
  id: string;
  name: string;
  url: string;
  keyId: string;
  sealed: string;
  addedAt: number;
  last?: SiteCheck;
}

export interface AgencySiteView {
  id: string;
  name: string;
  url: string;
  addedAt: number;
  last: SiteCheck | null;
}

const place = (id: string) => `agency:${id}`;
const parse = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

async function stored(runner: SqlRunner, siteId: string): Promise<StoredSite[]> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, AGENCY_SITES_KEY],
  );
  const v = parse(runner, rows[0]?.["value"]) as { sites?: unknown } | null;
  return (Array.isArray(v?.sites) ? v.sites : []).filter(
    (s): s is StoredSite =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as StoredSite).id === "string" &&
      typeof (s as StoredSite).url === "string" &&
      typeof (s as StoredSite).sealed === "string",
  );
}

async function save(runner: SqlRunner, siteId: string, sites: StoredSite[]): Promise<void> {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, AGENCY_SITES_KEY, JSON.stringify({ sites }), new Date()],
  );
}

const view = (s: StoredSite): AgencySiteView => ({
  id: s.id,
  name: s.name,
  url: s.url,
  addedAt: s.addedAt,
  last: s.last ?? null,
});

export async function listAgencySites(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
): Promise<AgencySiteView[]> {
  if (!actor.can("settings.manage")) return [];
  return (await stored(runner, siteId)).map(view);
}

type Fail = { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };
const fail = (code: Fail["code"], message: string): Fail => ({ ok: false, code, message });

export interface CallContext {
  fetch: typeof fetch;
  now: () => number;
  /** How long one site may take. */
  timeoutMs: number;
}

export type CallResult<T> =
  { ok: true; data: T } | { ok: false; code: NonNullable<SiteCheck["code"]>; message: string };

/** One signed request to a client site. Redirects are never followed: the signature belongs to one address. */
export async function callSite<T>(
  site: { url: string; keyId: string; secret: string },
  path: string,
  ctx: CallContext,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<CallResult<T>> {
  const method = options.method ?? "GET";
  const base = new URL(site.url);
  // The path is always inside the site's own address.
  const full = new URL(`${base.pathname.replace(/\/$/, "")}${path}`, base.origin);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const signed = signRequest({
    method,
    target: full.pathname + full.search,
    ...(body !== undefined ? { body } : {}),
    keyId: site.keyId,
    secret: site.secret,
    now: ctx.now(),
  });
  let response: Response;
  try {
    response = await ctx.fetch(full.toString(), {
      method,
      headers: { ...signed, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch {
    return {
      ok: false,
      code: "unreachable",
      message:
        "The site could not be reached (it did not answer in time, or the address is wrong).",
    };
  }
  if (response.status >= 300 && response.status < 400)
    return {
      ok: false,
      code: "refused",
      message:
        "The site sent the request to another address. Connect it again with its final https address.",
    };
  let text = "";
  try {
    text = (await response.text()).slice(0, RESPONSE_MAX_CHARS);
  } catch {
    // An answer that breaks off is treated as no answer.
  }
  let data: Record<string, unknown> | null;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = null;
  }
  if (response.ok && data && data["ok"] === true) return { ok: true, data: data as T };
  const said = typeof data?.["message"] === "string" ? String(data["message"]) : "";
  if (response.status === 401 && data?.["code"] === "clock")
    return { ok: false, code: "clock", message: `${said} Check the time of this server too.` };
  if (response.status === 401 || response.status === 403)
    return {
      ok: false,
      code: "refused",
      message:
        "The site did not accept the key. Make a new connection code on the site and connect it again.",
    };
  if (response.status === 404)
    return {
      ok: false,
      code: "missing",
      message:
        "The site has no connection switched on (no key was made), or it is too old for this dashboard.",
    };
  if (response.status === 501)
    return { ok: false, code: "not_available", message: said || "The site cannot do this yet." };
  return {
    ok: false,
    code: "failed",
    message: said || `The site answered with an error (${response.status}).`,
  };
}

export interface AgencyContext extends CallContext {
  /** Whether this install has an Agency key that lets the paid features run, and how many sites it is sold for. */
  agency: { active: boolean; limit: number };
}

export async function addAgencySite(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  input: { code: unknown; name?: unknown },
  ctx: AgencyContext,
): Promise<{ ok: true; id: string; site: AgencySiteView } | Fail> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not connect client sites.");
  if (!ctx.agency.active)
    return fail(
      "forbidden",
      "The agency dashboard needs an Agency key. Add one under Tools > Licences.",
    );
  const sites = await stored(runner, siteId);
  if (sites.length >= ctx.agency.limit)
    return fail(
      "invalid",
      `Your Agency key covers ${ctx.agency.limit} site${ctx.agency.limit === 1 ? "" : "s"}, and ${sites.length} ${sites.length === 1 ? "is" : "are"} connected. Add a key for more sites to connect another.`,
    );
  const parsed = parseConnectionCode(input.code);
  if (!parsed.ok) return fail("invalid", parsed.message);
  const checked = checkSiteUrl(parsed.url);
  if (!checked.ok) return fail("invalid", checked.message);
  if (sites.some((s) => s.url === checked.url))
    return fail("invalid", "This site is connected already. Remove it first to connect it again.");
  const asked = await callSite<unknown>(
    { url: checked.url, keyId: parsed.keyId, secret: parsed.secret },
    "/api/oks/v1/status",
    ctx,
  );
  if (!asked.ok) return fail("invalid", asked.message);
  const status = cleanStatus(asked.data);
  if (!status) return fail("invalid", "The site's answer was not understood.");
  const given = typeof input.name === "string" ? input.name.trim() : "";
  if (given.length > AGENCY_SITE_NAME_MAX)
    return fail("invalid", `The name can be at most ${AGENCY_SITE_NAME_MAX} characters.`);
  const id = newId();
  const record: StoredSite = {
    id,
    name: given || status.siteName || checked.url,
    url: checked.url,
    keyId: parsed.keyId,
    sealed: secrets.seal(parsed.secret, place(id)),
    addedAt: ctx.now(),
    last: { at: ctx.now(), ok: true, status },
  };
  await save(runner, siteId, [...sites, record]);
  return { ok: true, id, site: view(record) };
}

export async function removeAgencySite(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<{ ok: true } | Fail> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not change client sites.");
  const sites = await stored(runner, siteId);
  if (!sites.some((s) => s.id === id)) return fail("not_found", "This site is not connected.");
  await save(
    runner,
    siteId,
    sites.filter((s) => s.id !== id),
  );
  return { ok: true };
}

/**
 * Asks every site for its status, up to `concurrency` at a time. A site that does not answer in time is marked so; sites not
 * reached before `budgetMs` has run out keep their last state and are marked "late". The new states are saved in one step.
 */
export async function checkAgencySites(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  ctx: AgencyContext & { budgetMs: number; concurrency?: number },
): Promise<{ ok: true; sites: AgencySiteView[] } | Fail> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not check client sites.");
  if (!ctx.agency.active)
    return fail("forbidden", "Checking sites needs an Agency key that is still valid.");
  const sites = await stored(runner, siteId);
  const started = ctx.now();
  const results = new Map<string, SiteCheck>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const mine = sites[next++];
      if (!mine) return;
      if (ctx.now() - started >= ctx.budgetMs) {
        results.set(mine.id, {
          at: ctx.now(),
          ok: false,
          code: "late",
          error: "There was no time left to check this site. Check again.",
        });
        continue;
      }
      let secret: string;
      try {
        secret = secrets.open(mine.sealed, place(mine.id));
      } catch {
        results.set(mine.id, {
          at: ctx.now(),
          ok: false,
          code: "refused",
          error: "The saved key cannot be read. Connect the site again.",
        });
        continue;
      }
      const left = Math.max(1, ctx.budgetMs - (ctx.now() - started));
      const r = await callSite<unknown>(
        { url: mine.url, keyId: mine.keyId, secret },
        "/api/oks/v1/status",
        { ...ctx, timeoutMs: Math.min(ctx.timeoutMs, left) },
      );
      const status = r.ok ? cleanStatus(r.data) : null;
      results.set(
        mine.id,
        r.ok
          ? status
            ? { at: ctx.now(), ok: true, status }
            : {
                at: ctx.now(),
                ok: false,
                code: "failed",
                error: "The site's answer was not understood.",
              }
          : { at: ctx.now(), ok: false, code: r.code, error: r.message },
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(ctx.concurrency ?? 10, sites.length) }, worker));
  // The list may have changed while the sites answered: only the sites still there take a new state.
  const current = await stored(runner, siteId);
  const merged = current.map((s) => (results.has(s.id) ? { ...s, last: results.get(s.id)! } : s));
  await save(runner, siteId, merged);
  return { ok: true, sites: merged.map(view) };
}

/** How long a client site may take to make and check a backup (the dashboard waits this long for the answer). */
export const BACKUP_WAIT_MS = 180_000;

/**
 * Asks a connected site to make a backup now (the connector's `backup` action: the site makes it and checks it, and answers when it
 * is done). The site's state is asked for again afterwards, so the dashboard shows the new "last backup" at once.
 */
export async function requestSiteBackup(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  id: string,
  ctx: AgencyContext,
): Promise<
  { ok: true; backup: { createdAt: number; size: number; rows: number; files: number } } | Fail
> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not back up client sites.");
  if (!ctx.agency.active)
    return fail("forbidden", "Backing up client sites needs an Agency key that is still valid.");
  const opened = await openAgencySite(runner, siteId, secrets, id);
  if (!opened.ok) return fail(opened.code, opened.message);
  const made = await callSite<unknown>(
    opened,
    "/api/oks/v1/backup",
    { ...ctx, timeoutMs: Math.max(ctx.timeoutMs, BACKUP_WAIT_MS) },
    { method: "POST", body: {} },
  );
  if (!made.ok) return fail("invalid", made.message);
  const d = obj(made.data);
  const backup = {
    createdAt: orNull(d["createdAt"]) ?? 0,
    size: count(d["size"]),
    rows: count(d["rows"]),
    files: count(d["files"]),
  };
  // The site's state now shows the new backup. If it cannot be asked, the backup is still made.
  const asked = await callSite<unknown>(opened, "/api/oks/v1/status", ctx);
  const status = asked.ok ? cleanStatus(asked.data) : null;
  if (status) {
    const sites = await stored(runner, siteId);
    await save(
      runner,
      siteId,
      sites.map((s) => (s.id === id ? { ...s, last: { at: ctx.now(), ok: true, status } } : s)),
    );
  }
  return { ok: true, backup };
}

export const REPORT_DAYS = [7, 30, 90] as const;

/** A connected site with its key opened, for the requests the dashboard makes. */
export async function openAgencySite(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  id: string,
): Promise<
  | { ok: true; name: string; url: string; keyId: string; secret: string }
  | { ok: false; code: "not_found" | "invalid"; message: string }
> {
  const mine = (await stored(runner, siteId)).find((s) => s.id === id);
  if (!mine) return { ok: false, code: "not_found", message: "This site is not connected." };
  try {
    return {
      ok: true,
      name: mine.name,
      url: mine.url,
      keyId: mine.keyId,
      secret: secrets.open(mine.sealed, place(mine.id)),
    };
  } catch {
    return {
      ok: false,
      code: "invalid",
      message: "The saved key cannot be read. Connect the site again.",
    };
  }
}

/** A client site's page and visit counts for the last `days` days (the same signed request, another fixed action). */
export async function fetchSiteReport(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  id: string,
  ctx: AgencyContext,
  days: number = 30,
): Promise<{ ok: true; report: ConnectorReport } | Fail> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not see client reports.");
  if (!ctx.agency.active)
    return fail("forbidden", "Client reports need an Agency key that is still valid.");
  if (!(REPORT_DAYS as readonly number[]).includes(days))
    return fail("invalid", "A report covers 7, 30 or 90 days.");
  const opened = await openAgencySite(runner, siteId, secrets, id);
  if (!opened.ok) return fail(opened.code, opened.message);
  const r = await callSite<unknown>(opened, `/api/oks/v1/report?days=${days}`, ctx);
  if (!r.ok) return fail("invalid", r.message);
  const report = cleanReport(r.data);
  if (!report) return fail("invalid", "The site's answer was not understood.");
  return { ok: true, report };
}
