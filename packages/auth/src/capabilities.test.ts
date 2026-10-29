// What a person may do on a site comes from their role there (spec 02, section 6), on SQLite and PostgreSQL. Used by
// the sandbox so that a plugin acting for a person never does more than that person may (PL-38).
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { capabilitiesOf } from "./capabilities.js";

const T = new Date(1_700_000_000_000);
const id = (prefix: string, key: string) => `${prefix}${key.toUpperCase().padEnd(23, "0")}`;
const SITE = id("SIT", "one");
const OTHER_SITE = id("SIT", "two");

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: capabilities from the role`, () => {
    let db: TestDb;
    const roles: Record<string, (string | [string, string])[]> = {
      author: ["content.create", "content.edit_own", "content.publish_own"],
      editor: ["content.edit_any", "content.publish_any", "content.read_private"],
      // A custom role limited to one content type (spec 02, section 6).
      recipes: [["content.edit_any", "recipe"]],
      administrator: [],
    };

    beforeAll(async () => {
      db = await open();
      for (const site of [SITE, OTHER_SITE])
        await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
          site,
          T,
          T,
        ]);
      for (const user of ["author", "editor", "recipes", "admin", "stranger", "elsewhere"])
        await db.run(
          "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
          [id("USR", user), user, `${user}@example.com`, T, T],
        );
      let n = 0;
      for (const [site, prefix] of [
        [SITE, "R1"],
        [OTHER_SITE, "R2"],
      ] as const)
        for (const [key, caps] of Object.entries(roles)) {
          await db.run(
            "insert into roles (id, site_id, key, label, is_system, created_at) values (?, ?, ?, ?, ?, ?)",
            [id(`ROL${prefix}`, key).slice(0, 26), site, key, key, true, T],
          );
          for (const c of caps) {
            const [capability, scope] = Array.isArray(c) ? c : [c, ""];
            await db.run(
              "insert into role_capabilities (id, role_id, capability, scope_type_key) values (?, ?, ?, ?)",
              [
                `CAP${String(++n).padStart(23, "0")}`,
                id(`ROL${prefix}`, key).slice(0, 26),
                capability,
                scope,
              ],
            );
          }
        }
      const member = (site: string, prefix: string, user: string, role: string) =>
        db.run(
          "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
          [site, id("USR", user), id(`ROL${prefix}`, role).slice(0, 26), T],
        );
      await member(SITE, "R1", "author", "author");
      await member(SITE, "R1", "editor", "editor");
      await member(SITE, "R1", "recipes", "recipes");
      await member(SITE, "R1", "admin", "administrator");
      // An administrator of another site only.
      await member(OTHER_SITE, "R2", "elsewhere", "administrator");
    });
    afterAll(async () => db?.close());

    const of = (user: string) => capabilitiesOf(db.runner, SITE, id("USR", user));

    test("PL-38 an Author may edit their own entries, not anyone's", async () => {
      const a = await of("author");
      expect(a.can("content.edit_own")).toBe(true);
      expect(a.can("content.edit_any")).toBe(false);
      expect(a.can("content.read_private")).toBe(false);
    });

    test("PL-38 an Editor may edit anyone's entries and read private ones", async () => {
      const e = await of("editor");
      expect(e.can("content.edit_any")).toBe(true);
      expect(e.can("content.edit_any", "recipe")).toBe(true);
      expect(e.can("content.read_private")).toBe(true);
      expect(e.can("users.manage")).toBe(false);
    });

    test("PL-38 a role limited to one content type does not reach another type, or all types", async () => {
      const r = await of("recipes");
      expect(r.can("content.edit_any", "recipe")).toBe(true);
      expect(r.can("content.edit_any", "post")).toBe(false);
      expect(r.can("content.edit_any")).toBe(false);
    });

    test("PL-38 an Administrator has every capability, also ones added later by plugins", async () => {
      const a = await of("admin");
      expect(a.can("users.manage")).toBe(true);
      expect(a.can("a-plugin.do_something")).toBe(true);
    });

    test("PL-38 someone who is not a member has nothing, even as an administrator of another site", async () => {
      for (const user of ["stranger", "elsewhere"]) {
        const s = await of(user);
        expect(s.can("content.edit_own")).toBe(false);
        expect(s.can("content.read_private")).toBe(false);
      }
    });
  });
}
