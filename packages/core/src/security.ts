// The security settings of a site (spec 02, section 3 and AU-37): "require two-factor for administrators". They are kept
// in the site's `settings` table under the key `security`.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const SECURITY_SETTINGS_KEY = "security";

export interface SecuritySettings {
  /** Administrators must have two-factor sign-in on; one without it can only reach their own account screen. */
  requireTwoFactorForAdmins: boolean;
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = { requireTwoFactorForAdmins: false };

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
  const saved = rows[0] ? asObject(rows[0]["value"]) : {};
  return { requireTwoFactorForAdmins: saved["requireTwoFactorForAdmins"] === true };
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
  const next: SecuritySettings = {
    requireTwoFactorForAdmins: input.requireTwoFactorForAdmins ?? current.requireTwoFactorForAdmins,
  };
  if (typeof next.requireTwoFactorForAdmins !== "boolean")
    return { ok: false, code: "invalid", message: "The rule must be on or off." };
  if (next.requireTwoFactorForAdmins && !(await hasTwoFactor(runner, actor.userId)))
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
