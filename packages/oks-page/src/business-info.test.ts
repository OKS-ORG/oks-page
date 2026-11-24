// The business the plugin describes, read by the site (spec 19, section 3): only while the plugin is installed and switched
// on, only for this site. In SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { loadBusinessInfo } from "./business-info";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000162";
const OTHER = "SITE0000000000000000000163";

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the business from the plugin's settings`, () => {
    let db: TestDb;
    let n = 0;
    const plugin = async (
      key: string,
      status: string,
      site: string,
      settings: Record<string, unknown>,
    ) => {
      n += 1;
      const id = `EXT${String(n).padStart(23, "0")}`;
      await db.run(
        "insert into extensions (id, site_id, key, kind, version, tier, status, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?, ?)",
        [id, site, key, status, T],
      );
      for (const [k, v] of Object.entries(settings))
        await db.run(
          "insert into extension_settings (extension_id, key, value, is_secret, updated_at) values (?, ?, ?, ?, ?)",
          [id, k, JSON.stringify(v), false, T],
        );
    };

    beforeEach(async () => {
      db = await open();
      n = 0;
      for (const id of [SITE, OTHER])
        await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
          id,
          T,
          T,
        ]);
    });

    test("nothing without the plugin, with it switched off, or with no business name", async () => {
      expect(await loadBusinessInfo(db.runner, SITE)).toBeNull();
      await plugin("business", "switched_off", SITE, { name: "Weber Garden Cafe" });
      expect(await loadBusinessInfo(db.runner, SITE)).toBeNull();
      await db.run("update extensions set status = 'enabled'");
      expect(await loadBusinessInfo(db.runner, SITE)).toMatchObject({ name: "Weber Garden Cafe" });
    });

    test("an empty business, another plugin's settings and another site's plugin do not count", async () => {
      await plugin("business", "enabled", SITE, { name: "  " });
      await plugin("other", "enabled", SITE, { name: "Not a business" });
      await plugin("business", "enabled", OTHER, { name: "Elsewhere" });
      expect(await loadBusinessInfo(db.runner, SITE)).toBeNull();
      expect(await loadBusinessInfo(db.runner, OTHER)).toMatchObject({ name: "Elsewhere" });
    });

    test("the details and the hours are read as they were saved", async () => {
      await plugin("business", "enabled", SITE, {
        name: "Weber Garden Cafe",
        city: "Berlin",
        hours_mon: "09:00-17:00",
        special_days: "2026-12-25 closed Christmas Day",
      });
      const b = await loadBusinessInfo(db.runner, SITE);
      expect(b?.city).toBe("Berlin");
      expect(b?.week).toEqual([{ day: 0, times: [["09:00", "17:00"]] }]);
      expect(b?.special).toEqual([{ date: "2026-12-25", note: "Christmas Day", times: [] }]);
    });
  });
}
