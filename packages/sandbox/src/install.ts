// Update and rollback (spec 04, section 10, rules 5 and 6; PL-33, PL-34).
import type { SqlRunner } from "@oks-page/db";
import { SandboxHost } from "./host.js";
import type { PluginManifest } from "./types.js";

export interface InstallService {
  /** Stores an update. If it asks for a permission the owner has not already granted, it is
   * kept pending and the plugin keeps running its current code until the owner approves it
   * (PL-33). Otherwise it is applied at once: the current bundle becomes the previous one (for
   * rollback) and the plugin is restarted on the new code. */
  update(input: UpdateInput): Promise<UpdateResult>;
  /** Approves a pending update: grants the permissions it asked for, moves the current bundle
   * to "previous", and restarts the plugin on the new one. Does nothing if there is no pending
   * update for this extension. */
  approveUpdate(input: ApproveUpdateInput): Promise<boolean>;
  /** Starts the previous bundle again. The plugin's stored data is untouched, because it is
   * kept by the extension's id, not by which code is running (PL-34). */
  rollback(input: RollbackInput): Promise<RollbackResult>;
}

export interface UpdateInput {
  extensionId: string;
  pluginId: string;
  version: string;
  code: string;
  /** The permissions the new version asks for (its whole list, as in its manifest). */
  permissions: string[];
}

export interface UpdateResult {
  applied: boolean;
  /** The permissions this update needs that were not already granted. Empty when applied. */
  newPermissions: string[];
}

export interface ApproveUpdateInput {
  extensionId: string;
  pluginId: string;
  grantedBy: string;
}

export interface RollbackInput {
  extensionId: string;
  pluginId: string;
}

export type RollbackResult = { ok: true } | { ok: false; reason: "no_previous_version" };

async function grantedPermissions(runner: SqlRunner, extensionId: string): Promise<string[]> {
  const rows = await runner.all(
    `select "permission" from "extension_permissions" where "extension_id" = ?`,
    [extensionId],
  );
  return rows.map((r) => String(r["permission"]));
}

function parsePermissions(raw: unknown, dialect: SqlRunner["dialect"]): string[] {
  // SQLite keeps JSON as text; the PostgreSQL driver has already parsed jsonb.
  const value = dialect === "sqlite" && typeof raw === "string" ? JSON.parse(raw) : raw;
  return Array.isArray(value) ? value.map(String) : [];
}

export function createInstallService(runner: SqlRunner, host: SandboxHost): InstallService {
  return {
    async update({ extensionId, pluginId, version, code, permissions }) {
      const granted = await grantedPermissions(runner, extensionId);
      const newPermissions = permissions.filter((p) => !granted.includes(p));
      const integrity = SandboxHost.hashOf(code);
      if (newPermissions.length > 0) {
        await runner.all(
          `insert into "extension_pending_updates"
             ("extension_id", "version", "code", "integrity", "new_permissions", "created_at")
           values (?, ?, ?, ?, ?, ?)
           on conflict ("extension_id") do update set
             "version" = excluded."version",
             "code" = excluded."code",
             "integrity" = excluded."integrity",
             "new_permissions" = excluded."new_permissions",
             "created_at" = excluded."created_at"`,
          [extensionId, version, code, integrity, JSON.stringify(newPermissions), new Date()],
        );
        return { applied: false, newPermissions };
      }
      await applyBundle(runner, host, {
        extensionId,
        pluginId,
        version,
        code,
        integrity,
        permissions,
      });
      return { applied: true, newPermissions: [] };
    },

    async approveUpdate({ extensionId, pluginId, grantedBy }) {
      const rows = await runner.all(
        `select "version", "code", "integrity", "new_permissions" from "extension_pending_updates" where "extension_id" = ?`,
        [extensionId],
      );
      const row = rows[0];
      if (!row) return false;
      const newPermissions = parsePermissions(row["new_permissions"], runner.dialect);
      const now = new Date();
      await runner.transaction(async (tx) => {
        for (const permission of newPermissions) {
          await tx.all(
            `insert into "extension_permissions" ("extension_id", "permission", "granted_by", "granted_at")
             values (?, ?, ?, ?)
             on conflict ("extension_id", "permission") do nothing`,
            [extensionId, permission, grantedBy, now],
          );
        }
        await tx.all(`delete from "extension_pending_updates" where "extension_id" = ?`, [
          extensionId,
        ]);
      });
      const permissions = await grantedPermissions(runner, extensionId);
      await applyBundle(runner, host, {
        extensionId,
        pluginId,
        version: String(row["version"]),
        code: String(row["code"]),
        integrity: String(row["integrity"]),
        permissions,
      });
      return true;
    },

    async rollback({ extensionId, pluginId }) {
      const rows = await runner.all(
        `select "version", "code", "integrity" from "extension_previous_versions" where "extension_id" = ?`,
        [extensionId],
      );
      const previous = rows[0];
      if (!previous) return { ok: false, reason: "no_previous_version" };
      await runner.all(
        `update "extensions" set "version" = ?, "code" = ?, "integrity" = ? where "id" = ?`,
        [previous["version"], previous["code"], previous["integrity"], extensionId],
      );
      const permissions = await grantedPermissions(runner, extensionId);
      host.load(
        {
          id: pluginId,
          version: String(previous["version"]),
          permissions,
          integrity: String(previous["integrity"]),
        },
        String(previous["code"]),
        extensionId,
      );
      return { ok: true };
    },
  };
}

async function applyBundle(
  runner: SqlRunner,
  host: SandboxHost,
  input: {
    extensionId: string;
    pluginId: string;
    version: string;
    code: string;
    integrity: string;
    permissions: string[];
  },
): Promise<void> {
  const current = await runner.all(
    `select "version", "code", "integrity" from "extensions" where "id" = ?`,
    [input.extensionId],
  );
  const now = new Date();
  await runner.transaction(async (tx) => {
    const row = current[0];
    if (row && row["code"] != null) {
      await tx.all(
        `insert into "extension_previous_versions" ("extension_id", "version", "code", "integrity", "replaced_at")
         values (?, ?, ?, ?, ?)
         on conflict ("extension_id") do update set
           "version" = excluded."version",
           "code" = excluded."code",
           "integrity" = excluded."integrity",
           "replaced_at" = excluded."replaced_at"`,
        [input.extensionId, row["version"], row["code"], row["integrity"], now],
      );
    }
    await tx.all(
      `update "extensions" set "version" = ?, "code" = ?, "integrity" = ? where "id" = ?`,
      [input.version, input.code, input.integrity, input.extensionId],
    );
  });
  const manifest: PluginManifest = {
    id: input.pluginId,
    version: input.version,
    permissions: input.permissions,
    integrity: input.integrity,
  };
  host.load(manifest, input.code, input.extensionId);
}
