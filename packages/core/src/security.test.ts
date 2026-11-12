import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { loadSecuritySettings, mustSetUpTwoFactor, saveSecuritySettings } from "./security.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the security settings`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor; // administrator
    let eve: Actor; // editor

    const setTwoFactor = (userId: string, on: boolean) =>
      db.run("update users set two_factor_enabled = ? where id = ?", [on, userId]);

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const userId = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [userId, name, email, T, T],
          );
          return { userId };
        },
        {
          siteName: "S",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      anna = actorOf(setup.userId, "administrator");
      const eveId = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [eveId, "Eve", "eve@example.com", T, T],
      );
      const role = String((await db.run("select id from roles where key = 'editor'"))[0]!["id"]);
      await db.run(
        "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
        [siteId, eveId, role, T],
      );
      eve = actorOf(eveId, "editor");
    });
    afterEach(async () => {
      await db.close();
    });

    test("the rule is off at first", async () => {
      expect(await loadSecuritySettings(db.runner, siteId)).toEqual({
        requireTwoFactorForAdmins: false,
      });
      expect(await mustSetUpTwoFactor(db.runner, siteId, anna.userId)).toBe(false);
    });

    test("turning it on needs two-factor on your own account first", async () => {
      expect(
        await saveSecuritySettings(db.runner, anna, siteId, { requireTwoFactorForAdmins: true }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect((await loadSecuritySettings(db.runner, siteId)).requireTwoFactorForAdmins).toBe(false);
      await setTwoFactor(anna.userId, true);
      expect(
        await saveSecuritySettings(db.runner, anna, siteId, { requireTwoFactorForAdmins: true }),
      ).toMatchObject({ ok: true, settings: { requireTwoFactorForAdmins: true } });
      expect((await loadSecuritySettings(db.runner, siteId)).requireTwoFactorForAdmins).toBe(true);
    });

    test("turning it off needs no two-factor, and a second save keeps one row", async () => {
      await setTwoFactor(anna.userId, true);
      await saveSecuritySettings(db.runner, anna, siteId, { requireTwoFactorForAdmins: true });
      await setTwoFactor(anna.userId, false);
      expect(
        await saveSecuritySettings(db.runner, anna, siteId, { requireTwoFactorForAdmins: false }),
      ).toMatchObject({ ok: true });
      const rows = await db.run("select revision from settings where key = 'security'");
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!["revision"])).toBe(2);
    });

    test("only people who manage the settings can save them, and the value must be on or off", async () => {
      expect(
        await saveSecuritySettings(db.runner, eve, siteId, { requireTwoFactorForAdmins: false }),
      ).toMatchObject({ ok: false, code: "forbidden" });
      expect(
        await saveSecuritySettings(db.runner, anna, siteId, {
          requireTwoFactorForAdmins: "yes" as never,
        }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect(await db.run("select 1 from settings where key = 'security'")).toHaveLength(0);
    });

    test("with the rule on, an administrator without two-factor must set it up; others and those with it do not (AU-37)", async () => {
      await setTwoFactor(anna.userId, true);
      await saveSecuritySettings(db.runner, anna, siteId, { requireTwoFactorForAdmins: true });
      expect(await mustSetUpTwoFactor(db.runner, siteId, anna.userId)).toBe(false);
      await setTwoFactor(anna.userId, false);
      expect(await mustSetUpTwoFactor(db.runner, siteId, anna.userId)).toBe(true);
      // An editor is not an administrator: the rule does not touch them.
      expect(await mustSetUpTwoFactor(db.runner, siteId, eve.userId)).toBe(false);
      // Someone who is not a member of the site has nothing to set up.
      expect(await mustSetUpTwoFactor(db.runner, siteId, newId())).toBe(false);
    });

    test("a damaged saved value means the rule is off", async () => {
      await db.run(
        "insert into settings (site_id, key, value, revision, updated_at) values (?, 'security', ?, 1, ?)",
        [siteId, JSON.stringify({ requireTwoFactorForAdmins: "yes" }), T],
      );
      expect((await loadSecuritySettings(db.runner, siteId)).requireTwoFactorForAdmins).toBe(false);
    });
  });
}
