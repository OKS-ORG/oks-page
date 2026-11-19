// The security settings of a site (spec 02, section 3 and AU-37): "require two-factor for administrators". They are kept
// in the site's `settings` table under the key `security`.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const SECURITY_SETTINGS_KEY = "security";

export interface SecuritySettings {
  /** Administrators must have two-factor sign-in on; one without it can only reach their own account screen. */
  requireTwoFactorForAdmins: boolean;
  /**
   * Hosts, besides the site's own address, that a public page may load stylesheets from (TH-49, ADR 0038). Plain host
   * names such as "assets.example.com", checked by `normalizeStyleHost`. Empty unless an administrator adds one.
   */
  styleHosts: string[];
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  requireTwoFactorForAdmins: false,
  styleHosts: [],
};

/** At most this many extra hosts: a short list is easier to trust. */
export const MAX_STYLE_HOSTS = 10;

const HOST_NAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * One host for the stylesheet rule, or a plain-words reason why not. An address with `https://` and a closing slash is
 * accepted and cleaned. Never allowed: a wildcard, `http:`, a port, a path, a name with no dot (such as `localhost`) and
 * a number address.
 */
export function normalizeStyleHost(
  raw: unknown,
): { ok: true; host: string } | { ok: false; message: string } {
  if (typeof raw !== "string")
    return {
      ok: false,
      message: "A host must be written as text, for example assets.example.com.",
    };
  let host = raw.trim().toLowerCase();
  if (host.includes("*"))
    return { ok: false, message: "A wildcard (*) is not allowed. Write the exact host." };
  if (host.startsWith("http://"))
    return { ok: false, message: "Only https is allowed. A host on http is not safe." };
  if (host.startsWith("https://")) host = host.slice("https://".length);
  host = host.replace(/\/+$/, "");
  if (host === "") return { ok: false, message: "Write a host, for example assets.example.com." };
  if (/[/:@?#\s]/.test(host))
    return {
      ok: false,
      message: `"${raw.trim()}" must be a host name only: no path, no port and no sign-in part.`,
    };
  if (/^[0-9.]+$/.test(host))
    return { ok: false, message: "A number address is not allowed. Write a host name." };
  if (host.length > 253 || !HOST_NAME.test(host))
    return {
      ok: false,
      message: `"${raw.trim()}" is not a valid host name. Write it like assets.example.com (letters, numbers, dots and hyphens).`,
    };
  return { ok: true, host };
}

/** The checked, de-duplicated list, or the reason the first bad entry or the size was refused. */
export function checkStyleHosts(
  raw: unknown,
): { ok: true; hosts: string[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: "The hosts must be a list." };
  const hosts: string[] = [];
  for (const item of raw) {
    const one = normalizeStyleHost(item);
    if (!one.ok) return one;
    if (!hosts.includes(one.host)) hosts.push(one.host);
  }
  if (hosts.length > MAX_STYLE_HOSTS)
    return { ok: false, message: `At most ${MAX_STYLE_HOSTS} extra hosts are allowed.` };
  return { ok: true, hosts };
}

/** The rule about where stylesheets may come from: the site itself and the named hosts, all over https. */
export function styleSrcElemRule(hosts: readonly string[]): string {
  return ["style-src-elem 'self'", ...hosts.map((h) => `https://${h}`)].join(" ");
}

export type SecurityResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "invalid"; message: string };

const asObject = (raw: unknown): Record<string, unknown> => {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
};

const isOn = (value: unknown): boolean => value === true || Number(value) === 1;

export async function loadSecuritySettings(
  runner: SqlRunner,
  siteId: string,
): Promise<SecuritySettings> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, SECURITY_SETTINGS_KEY],
  );
  return readSecuritySettings(rows[0] ? rows[0]["value"] : null);
}

/** The settings from a saved value; anything damaged falls back to the safe default (rule off, no extra host). */
export function readSecuritySettings(raw: unknown): SecuritySettings {
  const saved = asObject(raw);
  const hosts = Array.isArray(saved["styleHosts"])
    ? (saved["styleHosts"] as unknown[]).flatMap((h) => {
        const one = normalizeStyleHost(h);
        return one.ok ? [one.host] : [];
      })
    : [];
  return {
    requireTwoFactorForAdmins: saved["requireTwoFactorForAdmins"] === true,
    styleHosts: [...new Set(hosts)].slice(0, MAX_STYLE_HOSTS),
  };
}

async function hasTwoFactor(runner: SqlRunner, userId: string): Promise<boolean> {
  const rows = await runner.all(`select "two_factor_enabled" from "users" where "id" = ?`, [
    userId,
  ]);
  return rows[0] ? isOn(rows[0]["two_factor_enabled"]) : false;
}

/**
 * Saves the security settings. Only people who manage the settings can. Turning the rule on is refused for someone who
 * has not turned on two-factor for their own account, so nobody locks themselves out.
 */
export async function saveSecuritySettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: Partial<SecuritySettings>,
): Promise<SecurityResult<{ settings: SecuritySettings }>> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the settings." };
  const current = await loadSecuritySettings(runner, siteId);
  let styleHosts = current.styleHosts;
  if (input.styleHosts !== undefined) {
    const checked = checkStyleHosts(input.styleHosts);
    if (!checked.ok) return { ok: false, code: "invalid", message: checked.message };
    styleHosts = checked.hosts;
  }
  const next: SecuritySettings = {
    requireTwoFactorForAdmins: input.requireTwoFactorForAdmins ?? current.requireTwoFactorForAdmins,
    styleHosts,
  };
  if (typeof next.requireTwoFactorForAdmins !== "boolean")
    return { ok: false, code: "invalid", message: "The rule must be on or off." };
  // The lock-out check is only for turning the rule on now, not for saving the hosts of a site where it is already on.
  if (
    input.requireTwoFactorForAdmins === true &&
    !current.requireTwoFactorForAdmins &&
    !(await hasTwoFactor(runner, actor.userId))
  )
    return {
      ok: false,
      code: "invalid",
      message: "Turn on two-factor sign-in for your own account first, then turn this rule on.",
    };
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, SECURITY_SETTINGS_KEY, JSON.stringify(next), new Date()],
  );
  return { ok: true, settings: next };
}

/**
 * True when the rule is on, this person is an administrator of the site, and two-factor is not on for them. They are
 * then sent to their account screen to set it up (AU-37).
 */
export async function mustSetUpTwoFactor(
  runner: SqlRunner,
  siteId: string,
  userId: string,
): Promise<boolean> {
  if (!(await loadSecuritySettings(runner, siteId)).requireTwoFactorForAdmins) return false;
  const admin = await runner.all(
    `select 1 as found from "site_members" m join "roles" r on r."id" = m."role_id"
      where m."site_id" = ? and m."user_id" = ? and r."key" = 'administrator' limit 1`,
    [siteId, userId],
  );
  if (admin.length === 0) return false;
  return !(await hasTwoFactor(runner, userId));
}
