// Update checks, part 1 (spec 14, sections 3, 4 and 5): the site fetches our one signed list, keeps the newest believable
// one, and compares it with what it runs. The request carries nothing about the site (UP-01): no cookie, no query, no site
// name, no version; the user agent is just the product name. The signature, the sequence number and the age are decided by
// update-list.ts; this file is the fetching, the keeping and the comparing.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import {
  UPDATE_PUBLIC_KEYS,
  mayReplaceList,
  readUpdateList,
  updateListStale,
  type SecurityWarning,
  type UpdateItem,
  type UpdateList,
} from "./update-list.js";

export const UPDATES_SETTINGS_KEY = "updates_settings";
export const UPDATES_STATE_KEY = "updates_state";
/** The site looks once a day; the admin screen asks again when the last look is older than this. */
export const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const parse = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
async function read(
  runner: SqlRunner,
  siteId: string,
  key: string,
): Promise<Record<string, unknown>> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  const v = parse(runner, rows[0]?.["value"]);
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
async function write(
  runner: SqlRunner,
  siteId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date()],
  );
}

// ---- versions ----

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Compares two versions: negative when a is older, 0 when equal. A version with a "-beta" part is older than the same one without. */
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  const pa = x[4];
  const pb = y[4];
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  const sa = pa.split(".");
  const sb = pb.split(".");
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const p = sa[i];
    const q = sb[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a version is inside what a warning names: "1.2.0" (that one), "<1.4.3", "<=1.4.2", ">1.0.0", ">=1.2.0", or several
 * joined by commas, all of which must hold ("<1.4.3,>=1.2.0"). Anything it does not understand matches nothing, so a strange
 * line never raises a false alarm.
 */
export function versionMatches(version: string, spec: string): boolean {
  if (!VERSION.test(version)) return false;
  const parts = spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const m = /^(<=|>=|<|>|=)?\s*(\S+)$/.exec(part);
    if (!m || !VERSION.test(m[2]!)) return false;
    const d = compareVersions(version, m[2]!);
    switch (m[1]) {
      case "<":
        return d < 0;
      case "<=":
        return d <= 0;
      case ">":
        return d > 0;
      case ">=":
        return d >= 0;
      default:
        return d === 0;
    }
  });
}

// ---- the comparison ----

export interface InstalledItem {
  key: string;
  kind: "plugin" | "theme";
  name: string;
  version: string;
}

export interface CoreStatus {
  current: string;
  /** The newest version of the major version the site runs, when the list says. */
  latest: string | null;
  behind: boolean;
  /** False when the list names no version of the site's major version although it names others (spec 14, section 5). */
  supported: boolean;
}

export interface ItemStatus extends InstalledItem {
  /** False when the list does not know the item ("Updates are not checked for this plugin"). */
  tracked: boolean;
  latest: string | null;
  behind: boolean;
  /** The version in use is marked unsafe. */
  unsafe: boolean;
}

export interface Comparison {
  core: CoreStatus;
  items: ItemStatus[];
  /** The warnings that name something this site runs, worst first. */
  warnings: SecurityWarning[];
}

const RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

export function compareUpdates(
  list: UpdateList,
  installed: { core: string; items: InstalledItem[] },
): Comparison {
  const major = installed.core.split(".")[0] ?? "";
  const latestCore = list.core[major] ?? null;
  const known = Object.keys(list.core).length > 0;
  const core: CoreStatus = {
    current: installed.core,
    latest: latestCore,
    behind: latestCore !== null && compareVersions(installed.core, latestCore) < 0,
    supported: !known || latestCore !== null,
  };
  const byKey = new Map<string, UpdateItem>(list.items.map((i) => [i.key, i]));
  const items: ItemStatus[] = installed.items.map((item) => {
    const entry = byKey.get(item.key);
    return {
      ...item,
      tracked: entry !== undefined,
      latest: entry?.latest ?? null,
      behind: entry !== undefined && compareVersions(item.version, entry.latest) < 0,
      unsafe: entry !== undefined && entry.unsafe.includes(item.version),
    };
  });
  const versionOf = new Map<string, string>([["core", installed.core]]);
  for (const item of installed.items) versionOf.set(item.key, item.version);
  const warnings = list.warnings
    .filter((w) => {
      const v = versionOf.get(w.affects);
      return v !== undefined && versionMatches(v, w.versions);
    })
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return { core, items, warnings };
}

// ---- settings and state ----

/** Whether update checks are on (they are, unless the owner switched them off). */
export async function updateChecksOn(runner: SqlRunner, siteId: string): Promise<boolean> {
  return (await read(runner, siteId, UPDATES_SETTINGS_KEY))["on"] !== false;
}

export async function saveUpdateChecksOn(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  on: unknown,
): Promise<
  { ok: true; on: boolean } | { ok: false; code: "forbidden" | "invalid"; message: string }
> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (typeof on !== "boolean")
    return { ok: false, code: "invalid", message: "The request was not understood." };
  await write(runner, siteId, UPDATES_SETTINGS_KEY, { on });
  return { ok: true, on };
}

export interface UpdateState {
  /** The newest list that was believed, kept as it was signed, so it is read again with the keys built in at the time. */
  token: string | null;
  /** When the last look ended well (a list was fetched and believed or was the same). */
  checkedAt: number | null;
  /** When the last look was made, well or not. */
  triedAt: number | null;
  /** What went wrong at the last look, until a look works again. */
  failure: string;
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

export async function loadUpdateState(runner: SqlRunner, siteId: string): Promise<UpdateState> {
  const v = await read(runner, siteId, UPDATES_STATE_KEY);
  return {
    token: typeof v["token"] === "string" ? v["token"] : null,
    checkedAt: num(v["checkedAt"]),
    triedAt: num(v["triedAt"]),
    failure: typeof v["failure"] === "string" ? v["failure"] : "",
  };
}

async function saveState(runner: SqlRunner, siteId: string, state: UpdateState): Promise<void> {
  await write(runner, siteId, UPDATES_STATE_KEY, state);
}

/** The list the site holds, believed again with the keys it has now (a list that no longer passes is not used). */
export function heldList(
  state: UpdateState,
  keys: readonly string[] = UPDATE_PUBLIC_KEYS,
): UpdateList | null {
  if (state.token === null) return null;
  const read = readUpdateList(state.token, keys);
  return read.ok ? read.list : null;
}

// ---- the check ----

export type CheckOutcome =
  | { status: "off" }
  | { status: "no_server" }
  | { status: "same" | "new"; seq: number }
  | { status: "refused" | "failed"; reason: string };

export interface CheckOptions {
  /** The address of the list (https). Without one there is nothing to look at. */
  url: string | undefined;
  keys?: readonly string[];
  /** The product name (from brand.json, through the host): the only thing the request says about the sender. */
  userAgent: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Looks at the list once: fetch it, believe it or refuse it, keep it, and note how it went. Never throws. */
export async function runUpdateCheck(
  runner: SqlRunner,
  siteId: string,
  options: CheckOptions,
): Promise<CheckOutcome> {
  if (!(await updateChecksOn(runner, siteId))) return { status: "off" };
  const url = options.url?.trim();
  if (!url) return { status: "no_server" };
  const now = options.now ?? Date.now;
  const keys = options.keys ?? UPDATE_PUBLIC_KEYS;
  const state = await loadUpdateState(runner, siteId);
  const fail = async (status: "refused" | "failed", reason: string): Promise<CheckOutcome> => {
    await saveState(runner, siteId, { ...state, triedAt: now(), failure: reason });
    return { status, reason };
  };
  let text: string;
  try {
    if (new URL(url).protocol !== "https:")
      return await fail("failed", "The update address must be https.");
    // UP-01: a plain request. No cookie, no query, no site name, no version.
    const response = await (options.fetch ?? fetch)(url, {
      method: "GET",
      headers: { "user-agent": options.userAgent, accept: "text/plain" },
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return await fail("failed", `The update server answered ${response.status}.`);
    text = await response.text();
  } catch {
    return await fail("failed", "The update server could not be reached.");
  }
  if (text.length > MAX_LIST_BYTES) return await fail("refused", "The list is far too large.");
  const read = readUpdateList(text, keys);
  if (!read.ok) return await fail("refused", read.reason);
  const held = heldList(state, keys);
  if (!mayReplaceList(held, read.list))
    return await fail("refused", "This list is older than the one the site already has.");
  const same = held !== null && held.seq === read.list.seq;
  await saveState(runner, siteId, {
    token: text.trim(),
    checkedAt: now(),
    triedAt: now(),
    failure: "",
  });
  return { status: same ? "same" : "new", seq: read.list.seq };
}

/** True when a look is due: checks are on, there is an address, and the last good look is more than a day old (spec 14, section 4). */
export function updateCheckDue(state: UpdateState, now: number): boolean {
  const last = Math.max(state.checkedAt ?? 0, state.triedAt ?? 0);
  return now - last >= UPDATE_CHECK_EVERY_MS;
}

// ---- what the Updates screen shows ----

export type UpdateHealth =
  | "off" // checks are switched off
  | "no_server" // no address, or no list was ever believed
  | "stale" // the newest list is more than 7 days old
  | "failing" // the last look failed
  | "ok";

export interface UpdateView {
  on: boolean;
  health: UpdateHealth;
  failure: string;
  checkedAt: number | null;
  /** The sequence number and date of the newest list that was believed. */
  seq: number | null;
  issued: string | null;
  comparison: Comparison | null;
}

export async function loadUpdateView(
  runner: SqlRunner,
  siteId: string,
  installed: { core: string; items: InstalledItem[] },
  options: { keys?: readonly string[]; now?: () => number; url?: string | undefined } = {},
): Promise<UpdateView> {
  const on = await updateChecksOn(runner, siteId);
  const state = await loadUpdateState(runner, siteId);
  const list = heldList(state, options.keys ?? UPDATE_PUBLIC_KEYS);
  const now = options.now ?? Date.now;
  let health: UpdateHealth = "ok";
  if (!on) health = "off";
  else if (list === null) health = state.failure !== "" ? "failing" : "no_server";
  else if (state.failure !== "") health = "failing";
  else if (updateListStale(list, new Date(now()))) health = "stale";
  return {
    on,
    health,
    failure: state.failure,
    checkedAt: state.checkedAt,
    seq: list?.seq ?? null,
    issued: list?.issued ?? null,
    comparison: list ? compareUpdates(list, installed) : null,
  };
}
