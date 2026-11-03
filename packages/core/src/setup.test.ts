// First-run setup on SQLite and PostgreSQL (installation guide; spec 02, section 3, rule 2).
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_ROLES } from "./roles.js";
import { isSetupDone, runSetup, SetupError, type CreateAccount, type SetupInput } from "./setup.js";

const T = new Date(1_700_000_000_000);
const input = (over: Partial<SetupInput> = {}, email = "anna@example.com"): SetupInput => ({
  siteName: "My Site",
  tagline: "Notes",
  purpose: "blog",
  admin: { name: "Anna", email, password: "a-long-password" },
  ...over,
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: first-run setup`, () => {
    let db: TestDb;
    let calls: number;
    /** Stands in for Better Auth: it only writes the user row. The real sign-up is tested in packages/auth. */
    const createAccount: CreateAccount = async ({ name, email }) => {
      calls++;
      const userId = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [userId, name, email, T, T],
      );
      return { userId };
    };
    const count = async (table: string) =>
      Number((await db.run(`select count(*) as n from ${table}`))[0]!["n"]);

    beforeEach(async () => {
      db = await open();
      calls = 0;
    });
    afterEach(async () => db.close());

    test("a new database is not set up; setup makes the site, the five roles, the Administrator and the settings", async () => {
      expect(await isSetupDone(db.runner)).toBe(false);
      const { siteId, userId } = await runSetup(db.runner, createAccount, input());
      expect(await isSetupDone(db.runner)).toBe(true);
      expect(await count("sites")).toBe(1);
      const site = (await db.run("select name from sites where id = ?", [siteId]))[0]!;
      expect(site["name"]).toBe("My Site");
      const roles = await db.run("select key from roles where site_id = ? order by key", [siteId]);
      expect(roles.map((r) => r["key"])).toEqual(DEFAULT_ROLES.map((r) => r.key).sort());
      const member = (
        await db.run(
          "select r.key as role from site_members m join roles r on r.id = m.role_id where m.site_id = ? and m.user_id = ?",
          [siteId, userId],
        )
      )[0]!;
      expect(member["role"]).toBe("administrator");
      const settings = Object.fromEntries(
        (await db.run("select key, value from settings where site_id = ?", [siteId])).map((r) => [
          r["key"],
          kind === "sqlite" ? JSON.parse(String(r["value"])) : r["value"], // PostgreSQL has parsed it already
        ]),
      );
      expect(settings).toEqual({ title: "My Site", tagline: "Notes", purpose: "blog" });
    });

    test("the default roles have the capabilities of spec 02, section 6", async () => {
      const { siteId } = await runSetup(db.runner, createAccount, input());
      const caps = async (role: string) =>
        (
          await db.run(
            "select c.capability from role_capabilities c join roles r on r.id = c.role_id where r.site_id = ? and r.key = ?",
            [siteId, role],
          )
        ).map((r) => String(r["capability"]));
      expect(await caps("subscriber")).toEqual(["content.read_members"]);
      expect(await caps("contributor")).not.toContain("content.publish_own");
      expect(await caps("author")).toContain("content.publish_own");
      expect(await caps("author")).not.toContain("content.edit_any");
      expect(await caps("editor")).toContain("content.publish_any");
      expect(await caps("editor")).not.toContain("settings.manage");
      expect(await caps("administrator")).toEqual(
        expect.arrayContaining([
          "settings.manage",
          "users.manage",
          "plugins.manage",
          "api_keys.manage",
        ]),
      );
    });

    test("once an Administrator exists the wizard is closed: no second site, no second account", async () => {
      await runSetup(db.runner, createAccount, input());
      const error = await runSetup(db.runner, createAccount, input({}, "bob@example.com")).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(SetupError);
      expect((error as SetupError).code).toBe("already_set_up");
      expect(calls).toBe(1);
      expect(await count("sites")).toBe(1);
      expect(await count("users")).toBe(1);
    });

    test("wrong answers are refused with the field to show the message at, and nothing is created", async () => {
      const cases: [Partial<SetupInput>, string][] = [
        [{ siteName: "   " }, "siteName"],
        [{ siteName: "x".repeat(201) }, "siteName"],
        [{ purpose: "shop" as never }, "purpose"],
        [{ admin: { name: " ", email: "a@example.com", password: "a-long-password" } }, "name"],
        [{ admin: { name: "A", email: "not-an-email", password: "a-long-password" } }, "email"],
        [{ admin: { name: "A", email: "a@example.com", password: "short" } }, "password"],
      ];
      for (const [over, field] of cases) {
        const error = await runSetup(db.runner, createAccount, input(over)).catch((e) => e);
        expect(error, field).toBeInstanceOf(SetupError);
        expect((error as SetupError).code).toBe("invalid");
        expect((error as SetupError).field).toBe(field);
      }
      expect(calls).toBe(0);
      expect(await count("sites")).toBe(0);
      expect(await count("users")).toBe(0);
    });

    test("an account that cannot be made (an email already taken) leaves no site behind", async () => {
      const refuse: CreateAccount = async () => {
        throw new Error("That email is already in use.");
      };
      const error = await runSetup(db.runner, refuse, input()).catch((e) => e);
      expect((error as SetupError).code).toBe("account");
      expect((error as SetupError).message).toBe("That email is already in use.");
      expect(await count("sites")).toBe(0);
      expect(await isSetupDone(db.runner)).toBe(false);
    });

    test("two people running setup at the same moment: one wins, the other is refused and leaves no account", async () => {
      const results = await Promise.allSettled([
        runSetup(db.runner, createAccount, input({}, "one@example.com")),
        runSetup(db.runner, createAccount, input({}, "two@example.com")),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((refused.reason as SetupError).code).toBe("already_set_up");
      expect(await count("sites")).toBe(1);
      expect(await count("users")).toBe(1);
      expect(await count("site_members")).toBe(1);
    });
  });
}
