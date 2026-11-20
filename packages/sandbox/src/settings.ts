// A plugin's settings (spec 04, section 9): what the manifest declares, saved for each installed plugin. Secret
// settings are sealed before they reach the database, read back in full only by that plugin through the host, and
// shown to the owner only as a hint (PL-39).
import type { SqlRunner } from "@oks-page/db";
import { SecretBox, secretHint } from "./secrets.js";
import type { SettingsSchema } from "./types.js";

/** What the admin gets for a secret setting: whether one is saved, and a hint. Never the secret itself. */
export interface SecretView {
  set: boolean;
  hint: string;
}

export interface PluginSettings {
  /** Saves the owner's values. Keys the plugin did not declare are refused. For a secret, `undefined` (the field left
   * as it was) keeps the saved one, an empty string removes it, and anything else replaces it. */
  save(extensionId: string, schema: SettingsSchema, values: Record<string, unknown>): Promise<void>;
  /** The values for the admin form: plain settings as saved, secrets only as a `SecretView`. */
  forAdmin(extensionId: string, schema: SettingsSchema): Promise<Record<string, unknown>>;
  /** One value for the plugin itself, a secret in full. Only the host calls this, for the plugin that is asking. */
  forPlugin(extensionId: string, key: string): Promise<unknown>;
}

export function createPluginSettings(options: {
  runner: SqlRunner;
  /** The site's OKS_SECRET. */
  siteSecret: string;
  clock?: () => Date;
}): PluginSettings {
  const { runner } = options;
  // Made when a secret is first used: a plain setting never needs the site's secret key.
  let sealed: SecretBox | undefined;
  const box = {
    seal: (plain: string, where: string) =>
      (sealed ??= new SecretBox(options.siteSecret)).seal(plain, where),
    open: (value: string, where: string) =>
      (sealed ??= new SecretBox(options.siteSecret)).open(value, where),
  };
  const now = options.clock ?? (() => new Date());
  const place = (extensionId: string, key: string) => `${extensionId}:${key}`;
  // SQLite keeps JSON as text; the PostgreSQL driver has already parsed jsonb.
  const parse = (raw: unknown) =>
    runner.dialect === "sqlite" && typeof raw === "string" ? JSON.parse(raw) : raw;
  const rowsOf = async (extensionId: string) =>
    new Map(
      (
        await runner.all(
          `select "key", "value", "is_secret" from "extension_settings" where "extension_id" = ?`,
          [extensionId],
        )
      ).map((r) => [
        String(r["key"]),
        { value: parse(r["value"]), secret: r["is_secret"] === true || r["is_secret"] === 1 },
      ]),
    );

  return {
    async save(extensionId, schema, values) {
      for (const key of Object.keys(values))
        if (!(key in schema)) throw new Error(`"${key}" is not a setting of this plugin`);
      await runner.transaction(async (tx) => {
        const write = (key: string, value: unknown, secret: boolean) =>
          tx.all(
            `insert into "extension_settings" ("extension_id", "key", "value", "is_secret", "updated_at") values (?, ?, ?, ?, ?)
             on conflict ("extension_id", "key") do update set "value" = excluded."value", "is_secret" = excluded."is_secret", "updated_at" = excluded."updated_at"`,
            [extensionId, key, JSON.stringify(value), secret, now()],
          );
        for (const [key, field] of Object.entries(schema)) {
          if (!(key in values)) continue;
          const value = values[key];
          if (field.type !== "secret") {
            await write(key, value ?? null, false);
            continue;
          }
          if (value === undefined) continue;
          if (value === "" || value === null) {
            await tx.all(
              `delete from "extension_settings" where "extension_id" = ? and "key" = ?`,
              [extensionId, key],
            );
            continue;
          }
          await write(key, box.seal(String(value), place(extensionId, key)), true);
        }
      });
    },

    async forAdmin(extensionId, schema) {
      const rows = await rowsOf(extensionId);
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(schema)) {
        const row = rows.get(key);
        if (field.type !== "secret") out[key] = row ? row.value : null;
        else if (!row || !row.secret) out[key] = { set: false, hint: "" } satisfies SecretView;
        else
          out[key] = {
            set: true,
            hint: secretHint(box.open(String(row.value), place(extensionId, key))),
          } satisfies SecretView;
      }
      return out;
    },

    async forPlugin(extensionId, key) {
      const row = (await rowsOf(extensionId)).get(key);
      if (!row) return null;
      return row.secret ? box.open(String(row.value), place(extensionId, key)) : row.value;
    },
  };
}
