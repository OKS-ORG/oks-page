// Blocked stylesheets (ADR 0038, point 5). A public page asks the browser to report a stylesheet it refused to load;
// the site keeps a short list of the hosts, and the administrator sees it in Settings > Security and on Home, with a
// button to add a host they trust. A report comes from any visitor's browser, so nothing in it is trusted: only a plain
// https host name that passes the same check as the setting is kept, the list is short, and nothing else is stored.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import { loadSecuritySettings, normalizeStyleHost } from "./security.js";

export const BLOCKED_STYLES_KEY = "blocked-styles";
/** At most this many hosts are kept; the oldest go first. */
export const MAX_BLOCKED_STYLES = 20;

export interface BlockedStyle {
  host: string;
  /** How many reports named it. */
  count: number;
  /** When the latest report came (ISO). */
  last: string;
  /** The address (path only) of the page that tried to load it. */
  page: string;
}

export interface StyleReport {
  host: string;
  page: string;
}

// A saved value comes back as text from SQLite and as an object from PostgreSQL.
const asObject = (raw: unknown): Record<string, unknown> => {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

/** The path of a page address, never the query or a fragment; empty when it is not an address. */
function pathOf(address: unknown): string {
  if (typeof address !== "string") return "";
  try {
    return new URL(address).pathname.slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * What a browser's report says, when it is about a refused stylesheet from an https host: the old shape
 * (`{"csp-report": {...}}`) and the newer one (a list of `{type: "csp-violation", body}`). Anything else is nothing.
 */
export function styleReportFrom(body: unknown): StyleReport | null {
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    const outer = asObject(entry);
    const inner =
      outer["type"] === "csp-violation" ? asObject(outer["body"]) : asObject(outer["csp-report"]);
    const directive = String(
      inner["effective-directive"] ??
        inner["effectiveDirective"] ??
        inner["violated-directive"] ??
        inner["violatedDirective"] ??
        "",
    );
    if (!/^style-src(-elem)?(\s|$)/.test(directive)) continue;
    const blocked = String(inner["blocked-uri"] ?? inner["blockedURL"] ?? "");
    let url: URL;
    try {
      url = new URL(blocked);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const host = normalizeStyleHost(url.hostname);
    if (!host.ok) continue;
    const documentAddress = inner["document-uri"] ?? inner["documentURL"];
    // The site's own files are never "blocked hosts".
    try {
      if (typeof documentAddress === "string" && new URL(documentAddress).hostname === url.hostname)
        continue;
    } catch {
      /* an unreadable document address does not matter */
    }
    return { host: host.host, page: pathOf(documentAddress) };
  }
  return null;
}

const readList = (raw: unknown): BlockedStyle[] => {
  const hosts = asObject(raw)["hosts"];
  if (!Array.isArray(hosts)) return [];
  return hosts.flatMap((h) => {
    const one = asObject(h);
    const host = normalizeStyleHost(one["host"]);
    if (!host.ok) return [];
    return [
      {
        host: host.host,
        count: Math.max(1, Number(one["count"]) || 1),
        last: typeof one["last"] === "string" ? one["last"] : new Date(0).toISOString(),
        page: typeof one["page"] === "string" ? one["page"].slice(0, 200) : "",
      },
    ];
  });
};

async function loadList(runner: SqlRunner, siteId: string): Promise<BlockedStyle[]> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, BLOCKED_STYLES_KEY],
  );
  return readList(rows[0] ? rows[0]["value"] : null);
}

async function saveList(runner: SqlRunner, siteId: string, hosts: BlockedStyle[], now: Date) {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, BLOCKED_STYLES_KEY, JSON.stringify({ hosts }), now],
  );
}

/** Keeps one report. A host that is already allowed is not kept. Returns true when the list changed. */
export async function recordBlockedStyle(
  runner: SqlRunner,
  siteId: string,
  report: StyleReport,
  now: () => number = Date.now,
): Promise<boolean> {
  if ((await loadSecuritySettings(runner, siteId)).styleHosts.includes(report.host)) return false;
  const list = await loadList(runner, siteId);
  const at = new Date(now());
  const known = list.find((b) => b.host === report.host);
  if (known) {
    known.count += 1;
    known.last = at.toISOString();
    if (report.page) known.page = report.page;
  } else list.push({ host: report.host, count: 1, last: at.toISOString(), page: report.page });
  list.sort((a, b) => b.last.localeCompare(a.last));
  await saveList(runner, siteId, list.slice(0, MAX_BLOCKED_STYLES), at);
  return true;
}

/** The hosts that were blocked and are still not allowed, newest first. */
export async function listBlockedStyles(
  runner: SqlRunner,
  siteId: string,
): Promise<BlockedStyle[]> {
  const allowed = new Set((await loadSecuritySettings(runner, siteId)).styleHosts);
  return (await loadList(runner, siteId))
    .filter((b) => !allowed.has(b.host))
    .sort((a, b) => b.last.localeCompare(a.last));
}

/** Forgets one host from the list (the administrator decided not to allow it). */
export async function dismissBlockedStyle(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  host: unknown,
  now: () => number = Date.now,
): Promise<{ ok: true } | { ok: false; code: "forbidden" | "invalid"; message: string }> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the settings." };
  const checked = normalizeStyleHost(host);
  if (!checked.ok) return { ok: false, code: "invalid", message: checked.message };
  const list = await loadList(runner, siteId);
  await saveList(
    runner,
    siteId,
    list.filter((b) => b.host !== checked.host),
    new Date(now()),
  );
  return { ok: true };
}
