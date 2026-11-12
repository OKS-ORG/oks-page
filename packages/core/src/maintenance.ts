// Maintenance mode (spec 07, settings): while it is on, visitors get a "we will be back soon" page (status 503) and
// administrators still see the real site. The setting is kept in the site's `settings` table under the key
// `maintenance`.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const MAINTENANCE_SETTINGS_KEY = "maintenance";

export const DEFAULT_MAINTENANCE_MESSAGE =
  "We are doing some maintenance. Please come back in a little while.";
export const MAINTENANCE_MESSAGE_MAX = 500;

export interface MaintenanceSettings {
  enabled: boolean;
  /** Shown to visitors as plain text. */
  message: string;
}

export const DEFAULT_MAINTENANCE_SETTINGS: MaintenanceSettings = {
  enabled: false,
  message: DEFAULT_MAINTENANCE_MESSAGE,
};

export type MaintenanceResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "invalid"; message: string };

/** What a saved value means: on only when it says so, and the message falls back to the default when empty or damaged. */
export function readMaintenanceSettings(raw: unknown): MaintenanceSettings {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  const saved = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const message = typeof saved["message"] === "string" ? saved["message"].trim() : "";
  return {
    enabled: saved["enabled"] === true,
    message:
      message && message.length <= MAINTENANCE_MESSAGE_MAX ? message : DEFAULT_MAINTENANCE_MESSAGE,
  };
}

export async function loadMaintenanceSettings(
  runner: SqlRunner,
  siteId: string,
): Promise<MaintenanceSettings> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, MAINTENANCE_SETTINGS_KEY],
  );
  return readMaintenanceSettings(rows[0]?.["value"]);
}

export async function saveMaintenanceSettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: Partial<MaintenanceSettings>,
): Promise<MaintenanceResult<{ settings: MaintenanceSettings }>> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the settings." };
  const current = await loadMaintenanceSettings(runner, siteId);
  const enabled = input.enabled ?? current.enabled;
  if (typeof enabled !== "boolean")
    return { ok: false, code: "invalid", message: "Maintenance mode must be on or off." };
  const message = input.message === undefined ? current.message : input.message;
  if (typeof message !== "string")
    return { ok: false, code: "invalid", message: "The message was not understood." };
  const trimmed = message.trim();
  if (trimmed.length > MAINTENANCE_MESSAGE_MAX)
    return {
      ok: false,
      code: "invalid",
      message: `The message may have at most ${MAINTENANCE_MESSAGE_MAX} characters.`,
    };
  const next: MaintenanceSettings = { enabled, message: trimmed || DEFAULT_MAINTENANCE_MESSAGE };
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, MAINTENANCE_SETTINGS_KEY, JSON.stringify(next), new Date()],
  );
  return { ok: true, settings: next };
}
