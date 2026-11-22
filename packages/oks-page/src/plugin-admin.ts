// Tools > Plugins: what the owner can do with the plugins of the site: see them, add one from a plugin file with the
// permissions approved, switch one on or off, and remove one (spec 04, sections 4 and 10). The checks run on the server;
// the screen only shows the answers.
import type { Actor } from "@oks-page/core";
import { newId, type SqlRunner } from "@oks-page/db";
import { pluginJobStatus, type PluginJobStatus } from "./plugin-jobs";
import {
  readAdminPages,
  permissionRisk,
  permissionWords,
  readPluginFile,
  type PluginFile,
  type PluginSettings,
  type SandboxHost,
  type SettingsSchema,
} from "@oks-page/sandbox";

export interface PluginPermission {
  permission: string;
  words: string;
  risk: "low" | "medium" | "high";
  /** True when the owner approved it (only meaningful for a plugin that is installed). */
  approved: boolean;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  status: "enabled" | "disabled" | "switched_off";
  permissions: PluginPermission[];
  hooks: string[];
  blocks: string[];
  /** True when the plugin declares settings for the owner to fill in. */
  hasSettings: boolean;
  /** The admin pages the plugin added (only while it is on and was given `admin:pages`). */
  pages: { id: string; title: string }[];
  /** The tasks the plugin runs by itself, with the last run and the next one. */
  jobs: PluginJobStatus[];
}

export type PluginResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: "forbidden" | "invalid" | "not_found" | "taken"; message: string };

const fail = (code: "forbidden" | "invalid" | "not_found" | "taken", message: string) =>
  ({ ok: false, code, message }) as const;

const parse = (value: unknown): Record<string, unknown> => {
  const v = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
};

const words = (permissions: string[], approved: string[] | null): PluginPermission[] =>
  permissions.map((permission) => ({
    permission,
    words: permissionWords(permission),
    risk: permissionRisk(permission),
    approved: approved === null ? true : approved.includes(permission),
  }));

/** The plugins installed on the site. `hostStatus` tells the state of one in the running host (it may have switched itself off). */
export async function listPlugins(
  runner: SqlRunner,
  siteId: string,
  hostStatus?: (id: string) => string,
): Promise<PluginInfo[]> {
  const rows = await runner.all(
    `select "id", "key", "version", "status", "manifest" from "extensions" where "site_id" = ? and "kind" = 'plugin' order by "key"`,
    [siteId],
  );
  const out: PluginInfo[] = [];
  for (const r of rows) {
    const manifest = parse(r["manifest"]);
    const granted = (
      await runner.all(
        `select "permission" from "extension_permissions" where "extension_id" = ?`,
        [String(r["id"])],
      )
    ).map((p) => String(p["permission"]));
    const asked = Array.isArray(manifest["permissions"])
      ? (manifest["permissions"] as string[])
      : granted;
    const key = String(r["key"]);
    const stored = String(r["status"]) as PluginInfo["status"];
    out.push({
      id: key,
      name: typeof manifest["displayName"] === "string" ? manifest["displayName"] : key,
      description: typeof manifest["description"] === "string" ? manifest["description"] : "",
      author: typeof manifest["author"] === "string" ? manifest["author"] : "",
      version: String(r["version"]),
      status:
        stored === "enabled" && hostStatus?.(key) === "switched_off" ? "switched_off" : stored,
      permissions: words([...new Set([...asked, ...granted])], granted),
      hooks: Array.isArray(manifest["hooks"]) ? (manifest["hooks"] as string[]) : [],
      blocks: Array.isArray(manifest["blocks"]) ? (manifest["blocks"] as string[]) : [],
      hasSettings:
        manifest["settings"] !== null &&
        typeof manifest["settings"] === "object" &&
        Object.keys(manifest["settings"] as object).length > 0,
      jobs: await pluginJobStatus(runner, siteId, key, manifest["jobs"]),
      pages: (() => {
        if (stored !== "enabled" || !granted.includes("admin:pages")) return [];
        const read = readAdminPages(manifest["adminPages"] ?? []);
        return typeof read === "string" ? [] : read.map((x) => ({ id: x.id, title: x.title }));
      })(),
    });
  }
  return out;
}

export interface PluginPreview {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  permissions: PluginPermission[];
  hooks: string[];
  blocks: string[];
  installed: boolean;
}

/** What the owner sees before approving: the plugin's name, its author and each permission in plain words. */
export async function previewPlugin(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  text: string,
): Promise<PluginResult<{ plugin: PluginPreview }>> {
  if (!actor.can("plugins.manage")) return fail("forbidden", "You may not manage plugins.");
  const read = readPluginFile(text);
  if (!read.ok) return fail("invalid", read.message);
  const m = read.file.manifest;
  const there = await runner.all(
    `select "id" from "extensions" where "site_id" = ? and "key" = ?`,
    [siteId, m.id],
  );
  return {
    ok: true,
    plugin: {
      id: m.id,
      name: m.displayName,
      description: m.description,
      author: m.author,
      version: m.version,
      permissions: words(m.permissions, null),
      hooks: m.hooks,
      blocks: m.blocks,
      installed: there.length > 0,
    },
  };
}

const note = async (
  runner: SqlRunner,
  siteId: string,
  actor: Actor,
  action: string,
  key: string,
  detail: Record<string, unknown>,
) =>
  runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id", "detail", "created_at") values (?, ?, 'user', ?, ?, 'plugin', ?, ?, ?)`,
    [newId(), siteId, actor.userId, action, key, JSON.stringify(detail), new Date()],
  );

/**
 * Adds a plugin from its file. The owner approves all of its permissions or only some of them (spec 04, section 4.1,
 * rule 6); a plugin with a permission refused works like one without it. A plugin of the same name is not replaced here.
 */
export async function installPlugin(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  text: string,
  approved: string[],
  source = "file",
): Promise<PluginResult<{ extensionId: string; file: PluginFile }>> {
  if (!actor.can("plugins.manage")) return fail("forbidden", "You may not manage plugins.");
  const read = readPluginFile(text);
  if (!read.ok) return fail("invalid", read.message);
  const file = read.file;
  const m = file.manifest;
  const extra = approved.filter((p) => !m.permissions.includes(p));
  if (extra.length > 0)
    return fail("invalid", "You approved a permission that the plugin does not ask for.");
  const there = await runner.all(
    `select "id" from "extensions" where "site_id" = ? and "key" = ?`,
    [siteId, m.id],
  );
  if (there.length > 0)
    return fail(
      "taken",
      `${m.displayName} is already installed. Remove it first to add this file (updating a plugin comes later).`,
    );
  const extensionId = newId();
  const at = new Date();
  await runner.all(
    `insert into "extensions" ("id", "site_id", "key", "kind", "version", "tier", "status", "code", "integrity", "manifest", "installed_at") values (?, ?, ?, 'plugin', ?, 'runtime', 'enabled', ?, ?, ?, ?)`,
    [extensionId, siteId, m.id, m.version, file.code, file.integrity, JSON.stringify(m), at],
  );
  for (const permission of new Set(approved))
    await runner.all(
      `insert into "extension_permissions" ("extension_id", "permission", "granted_by", "granted_at") values (?, ?, ?, ?)`,
      [extensionId, permission, actor.userId, at],
    );
  await note(runner, siteId, actor, "plugin.installed", m.id, {
    version: m.version,
    source,
    approved: [...new Set(approved)],
    refused: m.permissions.filter((p) => !approved.includes(p)),
  });
  return { ok: true, extensionId, file };
}

/** Switches a plugin on or off. */
export async function setPluginEnabled(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  key: string,
  enabled: boolean,
): Promise<PluginResult<{ extensionId: string }>> {
  if (!actor.can("plugins.manage")) return fail("forbidden", "You may not manage plugins.");
  const row = (
    await runner.all(
      `select "id" from "extensions" where "site_id" = ? and "key" = ? and "kind" = 'plugin'`,
      [siteId, key],
    )
  )[0];
  if (!row) return fail("not_found", "This plugin is not installed.");
  await runner.all(`update "extensions" set "status" = ? where "id" = ?`, [
    enabled ? "enabled" : "disabled",
    String(row["id"]),
  ]);
  await note(runner, siteId, actor, enabled ? "plugin.enabled" : "plugin.disabled", key, {});
  return { ok: true, extensionId: String(row["id"]) };
}

/** Removes a plugin with its storage, settings and permissions (they go with it). */
export async function removePlugin(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  key: string,
): Promise<PluginResult<object>> {
  if (!actor.can("plugins.manage")) return fail("forbidden", "You may not manage plugins.");
  const row = (
    await runner.all(
      `select "id" from "extensions" where "site_id" = ? and "key" = ? and "kind" = 'plugin'`,
      [siteId, key],
    )
  )[0];
  if (!row) return fail("not_found", "This plugin is not installed.");
  await runner.all(`delete from "extensions" where "id" = ?`, [String(row["id"])]);
  // Its timed runs go with it (a plugin id and a job name have only letters, digits and hyphens).
  await runner.all(`delete from "jobs" where "site_id" = ? and "kind" like ?`, [
    siteId,
    `plugin:${key}:%`,
  ]);
  await note(runner, siteId, actor, "plugin.removed", key, {});
  return { ok: true };
}

export interface PluginSettingsView {
  fields: { key: string; label: string; type: "text" | "number" | "boolean" | "secret" }[];
  /** Plain settings as saved (null when empty); a secret only as `{ set, hint }`. */
  values: Record<string, unknown>;
}

/** The settings a plugin declares, and the extension they belong to. */
async function schemaOf(
  runner: SqlRunner,
  siteId: string,
  key: string,
): Promise<{ extensionId: string; schema: SettingsSchema } | null> {
  const row = (
    await runner.all(
      `select "id", "manifest" from "extensions" where "site_id" = ? and "key" = ? and "kind" = 'plugin'`,
      [siteId, key],
    )
  )[0];
  if (!row) return null;
  const raw = parse(row["manifest"])["settings"];
  const schema = raw && typeof raw === "object" ? (raw as SettingsSchema) : {};
  return { extensionId: String(row["id"]), schema };
}

/** The settings form of a plugin: its fields and what is saved (a secret shows only that one is saved, and a hint). */
export async function loadPluginSettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  key: string,
  service: PluginSettings,
): Promise<PluginResult<{ settings: PluginSettingsView }>> {
  if (!actor.can("plugins.manage")) return fail("forbidden", "You may not manage plugins.");
  const found = await schemaOf(runner, siteId, key);
  if (!found) return fail("not_found", "This plugin is not installed.");
  const fields = Object.entries(found.schema).map(([k, f]) => ({
    key: k,
    label: f.label ?? k,
    type: f.type,
  }));
  if (fields.length === 0) return fail("not_found", "This plugin has no settings.");
  let values: Record<string, unknown>;
  try {
    values = await service.forAdmin(found.extensionId, found.schema);
  } catch {
    // A secret that cannot be opened (the site's secret key was changed): shown as not saved, and can be set again.
    values = {};
  }
  return { ok: true, settings: { fields, values } };
}

/**
 * Saves the owner's values. Each is checked against what the plugin declared (text up to 2,000 characters, a number, a
 * yes or no). For a secret, a value that is left out keeps the saved one and an empty one removes it. The values never
 * go to the audit log, only the names of the settings that were changed.
 */
export async function savePluginSettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  key: string,
  values: Record<string, unknown>,
  service: PluginSettings,
): Promise<PluginResult<object>> {
  if (!actor.can("plugins.manage")) return fail("forbidden", "You may not manage plugins.");
  const found = await schemaOf(runner, siteId, key);
  if (!found) return fail("not_found", "This plugin is not installed.");
  const clean: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(values)) {
    const field = found.schema[k];
    if (!field) return fail("invalid", `"${k}" is not a setting of this plugin.`);
    const name = field.label ?? k;
    if (field.type === "boolean") {
      if (typeof value !== "boolean") return fail("invalid", `"${name}" must be yes or no.`);
      clean[k] = value;
    } else if (field.type === "number") {
      if (value === "" || value === null) clean[k] = null;
      else if (typeof value === "number" && Number.isFinite(value)) clean[k] = value;
      else return fail("invalid", `"${name}" must be a number.`);
    } else {
      // text and secret
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > 2000)
        return fail("invalid", `"${name}" must be text of at most 2,000 characters.`);
      clean[k] = value;
    }
  }
  const wantsSecret = Object.entries(clean).some(
    ([k, v]) => found.schema[k]?.type === "secret" && v !== "" && v !== null,
  );
  if (wantsSecret && (process.env["OKS_SECRET"] ?? "").length < 32)
    return fail(
      "invalid",
      "A secret setting can be saved only when the site's OKS_SECRET (at least 32 characters) is set in its .env file.",
    );
  await service.save(found.extensionId, found.schema, clean);
  await note(runner, siteId, actor, "plugin.settings_changed", key, { keys: Object.keys(clean) });
  return { ok: true };
}

/** What the screen needs to know about the host: whether it can cap memory, and the notes plugins left for the owner. */
export async function hostFacts(
  host: SandboxHost,
): Promise<{ limitsNote: string | null; notices: string[] }> {
  return {
    limitsNote: host.limitsNote(),
    notices: [
      ...host.notices.map((n) => n.message),
      ...(await host.publishCheckNotes()).map((n) => n.message),
      ...(await host.permissionNotes()).map((n) => n.message),
    ],
  };
}
