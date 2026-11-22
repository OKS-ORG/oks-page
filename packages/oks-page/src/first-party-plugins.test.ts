// The plugins that ship with the product (spec 16, D133): what a new site starts with. Forms is installed with every
// permission it asks for, sends to the owner's own address, can be removed, and a failure never stops a site from being
// made. In SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { createPluginSettings, readPluginFile } from "@oks-page/sandbox";
import { beforeEach, describe, expect, test } from "vitest";
import { FORMS_PLUGIN_TEXT, installDefaultPlugins } from "./first-party-plugins";
import { loadPluginSettings, listPlugins, removePlugin } from "./plugin-admin";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000101";
const USER = "USER0000000000000000000101";

describe("the Forms plugin file kept in the package", () => {
  test("is a sound plugin file that asks for what Forms needs and nothing else", () => {
    const read = readPluginFile(FORMS_PLUGIN_TEXT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const m = read.file.manifest;
    expect(m.id).toBe("forms");
    expect([...m.permissions].sort()).toEqual([
      "admin:pages",
      "email:send",
      "files:private",
      "routes:public",
    ]);
    expect(m.blocks).toEqual(["form"]);
    expect(Object.keys(m.routes ?? {})).toEqual(["send"]);
    expect(Object.keys(m.jobs ?? {})).toEqual(["keep"]);
    expect(m.adminPages?.[0]?.id).toBe("messages");
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: plugins a new site starts with`, () => {
    let db: TestDb;
    const settings = () => createPluginSettings({ runner: db.runner, siteSecret: "s".repeat(40) });
    const owner = { userId: USER, can: () => true };

    beforeEach(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, 'Anna', 'anna@example.com', ?, ?)",
        [USER, T, T],
      );
    });

    test("Forms is installed and on, with every permission approved, and sends to the owner's address", async () => {
      const r = await installDefaultPlugins(db.runner, SITE, USER, "anna@example.com", settings());
      expect(r).toEqual({ ok: true });
      const listed = await listPlugins(db.runner, SITE);
      expect(listed.map((p) => [p.id, p.status])).toEqual([["forms", "enabled"]]);
      expect(listed[0]!.permissions.every((p) => p.approved)).toBe(true);
      expect(listed[0]!.pages.map((p) => p.id)).toEqual(["messages"]);
      expect(listed[0]!.jobs.map((j) => j.name)).toEqual(["keep"]);
      const view = await loadPluginSettings(db.runner, owner, SITE, "forms", settings());
      expect(view.ok && view.settings.values["send_to"]).toBe("anna@example.com");
      // The audit log says it was the setup that did it.
      const log = await db.runner.all(
        `select "detail" from "audit_log" where "site_id" = ? and "action" = 'plugin.installed'`,
        [SITE],
      );
      expect(log.length).toBe(1);
      expect(JSON.stringify(log[0]!["detail"])).toContain("setup");
    });

    test("running it twice does not install it twice, and the owner can remove it", async () => {
      await installDefaultPlugins(db.runner, SITE, USER, "anna@example.com", settings());
      const again = await installDefaultPlugins(
        db.runner,
        SITE,
        USER,
        "other@example.com",
        settings(),
      );
      expect(again).toEqual({ ok: true });
      expect((await listPlugins(db.runner, SITE)).length).toBe(1);
      // What is there is kept: the second address did not replace the first.
      const view = await loadPluginSettings(db.runner, owner, SITE, "forms", settings());
      expect(view.ok && view.settings.values["send_to"]).toBe("anna@example.com");
      expect((await removePlugin(db.runner, owner, SITE, "forms")).ok).toBe(true);
      expect(await listPlugins(db.runner, SITE)).toEqual([]);
    });

    test("a failure is answered, not thrown, so the site is still made", async () => {
      const broken = {
        ...settings(),
        save: async () => {
          throw new Error("the settings could not be saved");
        },
      } as unknown as ReturnType<typeof settings>;
      const r = await installDefaultPlugins(db.runner, SITE, USER, "anna@example.com", broken);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message).toContain("could not be saved");
    });
  });
}
