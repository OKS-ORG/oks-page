// Tools > Plugins: what the owner can do with the plugins of the site: see them, add one from a plugin file with the
// permissions approved, switch one on or off, and remove one (spec 04, sections 4 and 10). The checks run on the server;
// the screen only shows the answers.
import type { Actor } from "@oks-page/core";
import { newId, type SqlRunner } from "@oks-page/db";
import {
  permissionRisk,
  permissionWords,
  readPluginFile,
  type PluginFile,
  type SandboxHost,
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
  await note(runner, siteId, actor, "plugin.removed", key, {});
  return { ok: true };
}

/** What the screen needs to know about the host: whether it can cap memory, and the notes plugins left for the owner. */
export function hostFacts(host: SandboxHost): { limitsNote: string | null; notices: string[] } {
  return { limitsNote: host.limitsNote(), notices: host.notices.map((n) => n.message) };
}
