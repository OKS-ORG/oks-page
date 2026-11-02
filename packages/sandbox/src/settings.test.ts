// PL-39: a plugin's secret settings are sealed at rest, read in full only by that plugin, and never shown in full
// again, on SQLite and PostgreSQL, with the real sandbox host.
import { openers, type TestDb } from "@oks-page/db/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxHost } from "./host.js";
import { SecretBox, secretHint } from "./secrets.js";
import { createPluginSettings, type PluginSettings } from "./settings.js";
import type { SettingsSchema } from "./types.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000009";
const SITE_SECRET = "a-site-secret-that-is-long-enough-0123456789";
const API_KEY = "sk_live_51Hc0ffeeBadge4242";
const ext = (key: string) => `EXT${key.toUpperCase().padEnd(23, "0")}`;
const SCHEMA: SettingsSchema = {
  apiKey: { type: "secret", label: "API key" },
  units: { type: "text", label: "Units" },
};
const PLUGINS = {
  "secret-reader": `export default { hooks: { "content:afterSave": async (e, ctx) => ({ apiKey: await ctx.settings.get("apiKey"), units: await ctx.settings.get("units") }) } };`,
  nosy: `export default { hooks: { "content:afterSave": async (e, ctx) => ({ apiKey: await ctx.settings.get("apiKey") }) } };`,
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: plugin settings and secrets (PL-39)`, () => {
    let db: TestDb;
    let settings: PluginSettings;
    let host: SandboxHost;
    const raw = async (extensionId: string, key: string) =>
      (
        await db.run(
          `select "value", "is_secret" from "extension_settings" where "extension_id" = ? and "key" = ?`,
          [extensionId, key],
        )
      )[0];

    beforeAll(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      for (const key of [...Object.keys(PLUGINS), "other"])
        await db.run(
          "insert into extensions (id, site_id, key, kind, version, tier, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?)",
          [ext(key), SITE, key, T],
        );
      settings = createPluginSettings({
        runner: db.runner,
        siteSecret: SITE_SECRET,
        clock: () => T,
      });
      await settings.save(ext("secret-reader"), SCHEMA, { apiKey: API_KEY, units: "metric" });
      host = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: { get: async () => null, update: async () => null },
        pluginSettings: settings,
        workDir: mkdtempSync(join(tmpdir(), "oks-settings-")),
        wallMs: 2000,
      });
      await host.listen();
      for (const [key, code] of Object.entries(PLUGINS))
        host.load({ id: key, version: "1.0.0", permissions: [], settings: SCHEMA }, code, ext(key));
    }, 60_000);

    afterAll(async () => {
      await host?.close();
      await db?.close();
    });

    test("PL-39 a secret is stored sealed: the database never holds the plain secret", async () => {
      const row = await raw(ext("secret-reader"), "apiKey");
      const stored =
        typeof row!["value"] === "string" && kind === "sqlite"
          ? JSON.parse(String(row!["value"]))
          : row!["value"];
      expect(String(stored)).toMatch(/^v1:/);
      expect(JSON.stringify(row)).not.toContain(API_KEY);
      expect(JSON.stringify(row)).not.toContain(API_KEY.slice(4, 20));
      expect(row!["is_secret"] === true || row!["is_secret"] === 1).toBe(true);
    });

    test("PL-39 the admin sees a secret only as a hint, never in full; plain settings as they are", async () => {
      const view = await settings.forAdmin(ext("secret-reader"), SCHEMA);
      expect(view).toEqual({
        apiKey: { set: true, hint: `••••${API_KEY.slice(-4)}` },
        units: "metric",
      });
      expect(JSON.stringify(view)).not.toContain(API_KEY.slice(0, -4));
      expect(secretHint("short-key")).toBe("••••");
    });

    test("PL-39 the plugin reads its own secret in full through the host", async () => {
      const r = await host.call("secret-reader", "hook", "content:afterSave", {});
      expect(r.ok && r.result).toEqual({ apiKey: API_KEY, units: "metric" });
    });

    test("PL-39 another plugin asking for the same setting gets only its own (none)", async () => {
      const r = await host.call("nosy", "hook", "content:afterSave", {});
      expect(r.ok && r.result).toEqual({ apiKey: null });
    });

    test("PL-39 a sealed value copied to another plugin does not open there", async () => {
      const row = await raw(ext("secret-reader"), "apiKey");
      await db.run(
        `insert into "extension_settings" ("extension_id", "key", "value", "is_secret", "updated_at") values (?, 'apiKey', ?, ?, ?)`,
        [ext("other"), kind === "sqlite" ? row!["value"] : JSON.stringify(row!["value"]), true, T],
      );
      await expect(settings.forPlugin(ext("other"), "apiKey")).rejects.toThrow();
    });

    test("PL-39 another site's OKS_SECRET cannot open it", async () => {
      const elsewhere = createPluginSettings({
        runner: db.runner,
        siteSecret: "another-sites-secret-also-long-enough-987654",
      });
      await expect(elsewhere.forPlugin(ext("secret-reader"), "apiKey")).rejects.toThrow();
    });

    test("PL-39 leaving a secret as it was keeps it; an empty value removes it; a new value replaces it", async () => {
      await settings.save(ext("secret-reader"), SCHEMA, { units: "imperial" });
      expect(await settings.forPlugin(ext("secret-reader"), "apiKey")).toBe(API_KEY);
      await settings.save(ext("secret-reader"), SCHEMA, { apiKey: "sk_live_replacement_key_9999" });
      expect(await settings.forPlugin(ext("secret-reader"), "apiKey")).toBe(
        "sk_live_replacement_key_9999",
      );
      await settings.save(ext("secret-reader"), SCHEMA, { apiKey: "" });
      expect(await settings.forPlugin(ext("secret-reader"), "apiKey")).toBeNull();
      expect(await settings.forAdmin(ext("secret-reader"), SCHEMA)).toEqual({
        apiKey: { set: false, hint: "" },
        units: "imperial",
      });
    });

    test("PL-39 a setting the plugin did not declare is refused", async () => {
      await expect(settings.save(ext("secret-reader"), SCHEMA, { password: "x" })).rejects.toThrow(
        /not a setting/,
      );
    });
  });
}

describe("PL-39 the sealing itself", () => {
  test("a short OKS_SECRET is refused", () => {
    expect(() => new SecretBox("too-short")).toThrow(/at least 32/);
  });

  test("a changed sealed value does not open", () => {
    const box = new SecretBox(SITE_SECRET);
    const sealed = box.seal("hello", "place");
    const raw = Buffer.from(sealed.slice(3), "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => box.open(`v1:${raw.toString("base64")}`, "place")).toThrow();
    expect(box.open(sealed, "place")).toBe("hello");
  });

  test("sealing the same secret twice gives two different values", () => {
    const box = new SecretBox(SITE_SECRET);
    expect(box.seal("same", "p")).not.toBe(box.seal("same", "p"));
  });
});
