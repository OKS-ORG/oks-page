// The Client role (spec 11, section 4; AG-50 to AG-53) and the handoff checklist (section 9): what a client may and may not
// do, that a site made before the role existed gets it, and how the checklist is saved. In SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { HANDOFF_ITEMS, hintOf, loadHandoff, saveHandoff, type HandoffHints } from "./handoff.js";
import { DEFAULT_ROLES, ensureDefaultRoles } from "./roles.js";
import { runSetup } from "./setup.js";
import { listRoles } from "./users.js";

const T = new Date(1_700_000_000_000);
const roleOf = (key: string) => DEFAULT_ROLES.find((r) => r.key === key)!;
const can = (key: string): Actor["can"] => {
  const caps = roleOf(key).capabilities;
  return (c) => caps.includes(c);
};
const DAYS = 86_400_000;
const facts: HandoffHints = {
  twoFactor: { on: 1, total: 2 },
  emailWorks: false,
  privacyPage: false,
};

describe("the Client role", () => {
  test("writes and edits all content and the library; may delete only its own drafts", () => {
    const c = can("client");
    for (const yes of [
      "content.create",
      "content.edit_own",
      "content.edit_any",
      "content.delete_own",
      "content.read_members",
      "media.upload",
      "media.edit_own",
      "media.edit_any",
    ])
      expect(c(yes), yes).toBe(true);
  });

  test("cannot publish, change the design, plugins, settings or users, import or export, or delete what others wrote", () => {
    const c = can("client");
    for (const no of [
      "themes.manage",
      "plugins.manage",
      "settings.manage",
      "users.manage",
      "content_types.manage",
      "import",
      "export",
      "api_keys.manage",
      "menus.manage",
      "media.upload_svg",
      "content.publish_any",
      "content.publish_own",
      "content.delete_any",
      "media.delete_any",
      "comments.moderate",
    ])
      expect(c(no), no).toBe(false);
  });
});

describe("the handoff checklist's words", () => {
  test("each item has a plain title and reason, and the ids are unique", () => {
    expect(new Set(HANDOFF_ITEMS.map((i) => i.id)).size).toBe(HANDOFF_ITEMS.length);
    for (const i of HANDOFF_ITEMS) {
      expect(i.title.length).toBeGreaterThan(5);
      expect(i.why.length).toBeGreaterThan(20);
    }
    expect(HANDOFF_ITEMS.map((i) => i.id)).toContain("two-factor");
  });

  test("the site says what it can see for three items, and nothing for the others", () => {
    expect(hintOf("two-factor", facts)).toBe("Not yet: 1 of 2 administrators use two-factor.");
    expect(hintOf("two-factor", { ...facts, twoFactor: { on: 2, total: 2 } })).toBe(
      "Looks done: all 2 administrators use two-factor.",
    );
    expect(hintOf("two-factor", { ...facts, twoFactor: { on: 1, total: 1 } })).toBe(
      "Looks done: the administrator uses two-factor.",
    );
    expect(hintOf("two-factor", { ...facts, twoFactor: { on: 0, total: 1 } })).toBe(
      "Not yet: the administrator does not use two-factor.",
    );
    expect(hintOf("two-factor", { ...facts, twoFactor: { on: 0, total: 0 } })).toBe("");
    expect(hintOf("email", facts)).toBe("Not yet: email is not set up.");
    expect(hintOf("email", { ...facts, emailWorks: true })).toBe("Looks done: email is set up.");
    expect(hintOf("privacy", { ...facts, privacyPage: true })).toBe(
      "Looks done: a privacy page is chosen.",
    );
    expect(hintOf("hosting", facts)).toBe("");
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: roles and the handoff checklist`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, name, email, T, T],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      admin = { userId: setup.userId, can: can("administrator") };
      editor = { userId: setup.userId, can: can("editor") };
    });
    afterEach(async () => db.close());

    const keys = async () =>
      (
        await db.runner.all(`select "key" from "roles" where "site_id" = ? order by "key"`, [
          siteId,
        ])
      ).map((r) => String(r["key"]));

    test("a new site has the Client role with its capabilities", async () => {
      expect(await keys()).toContain("client");
      const caps = await db.runner.all(
        `select c."capability" from "role_capabilities" c join "roles" r on r."id" = c."role_id" where r."site_id" = ? and r."key" = 'client'`,
        [siteId],
      );
      expect(caps.map((c) => String(c["capability"])).sort()).toEqual(
        [...roleOf("client").capabilities].sort(),
      );
    });

    test("a site made before the role existed gets it when the roles are listed, once, and nothing else changes", async () => {
      await db.run(
        `delete from "role_capabilities" where "role_id" in (select "id" from "roles" where "site_id" = ? and "key" = 'client')`,
        [siteId],
      );
      await db.run(`delete from "roles" where "site_id" = ? and "key" = 'client'`, [siteId]);
      const before = (await keys()).length;
      expect((await listRoles(db.runner, siteId)).map((r) => r.key)).toContain("client");
      expect((await keys()).length).toBe(before + 1);
      expect(await ensureDefaultRoles(db.runner, siteId)).toBe(0);
      expect((await keys()).length).toBe(before + 1);
    });

    test("a role of the first set that was taken away is not brought back", async () => {
      await db.run(
        `delete from "role_capabilities" where "role_id" in (select "id" from "roles" where "site_id" = ? and "key" = 'contributor')`,
        [siteId],
      );
      await db.run(`delete from "roles" where "site_id" = ? and "key" = 'contributor'`, [siteId]);
      expect((await listRoles(db.runner, siteId)).map((r) => r.key)).not.toContain("contributor");
      expect(await ensureDefaultRoles(db.runner, siteId)).toBe(0);
    });

    test("the checklist starts empty, saves what is ticked in a fixed order, and a second save replaces the first", async () => {
      const first = await loadHandoff(db.runner, siteId, facts);
      expect([first.done, first.total]).toEqual([0, HANDOFF_ITEMS.length]);
      expect(
        await saveHandoff(db.runner, admin, siteId, { done: ["guide", "passwords", "guide"] }),
      ).toEqual({
        ok: true,
        done: ["passwords", "guide"],
      });
      const view = await loadHandoff(db.runner, siteId, facts);
      expect(view.items.filter((i) => i.done).map((i) => i.id)).toEqual(["passwords", "guide"]);
      expect(view.items.find((i) => i.id === "two-factor")!.hint).toContain("1 of 2");
      await saveHandoff(db.runner, admin, siteId, { done: [] });
      expect((await loadHandoff(db.runner, siteId, facts)).done).toBe(0);
    });

    test("only people who manage the settings may save it; an item that is not on the list, or a bad request, is refused", async () => {
      expect(await saveHandoff(db.runner, editor, siteId, { done: ["guide"] })).toMatchObject({
        code: "forbidden",
      });
      for (const bad of [
        { done: ["nothing"] },
        { done: "guide" },
        null,
        "x",
        { done: [1] },
        { done: Array(20).fill("guide") },
      ])
        expect(await saveHandoff(db.runner, admin, siteId, bad)).toMatchObject({ code: "invalid" });
      expect((await loadHandoff(db.runner, siteId, facts)).done).toBe(0);
    });

    test("a stored item that is not on the list any more is ignored", async () => {
      await db.run(
        `insert into settings (site_id, key, value, revision, updated_at) values (?, 'handoff', ?, 1, ?)`,
        [siteId, JSON.stringify({ done: ["passwords", "gone"] }), T],
      );
      expect(
        (await loadHandoff(db.runner, siteId, facts)).items.filter((i) => i.done).map((i) => i.id),
      ).toEqual(["passwords"]);
    });
  });
}

describe("the hint for the backups item", () => {
  test("it says whether a recent backup exists, and nothing when the site cannot say", () => {
    const now = Date.now();
    expect(hintOf("backups", { ...facts, backup: { lastAt: now - DAYS } })).toMatch(
      /^Looks done: the last backup was made on \d{4}-\d{2}-\d{2}/,
    );
    expect(hintOf("backups", { ...facts, backup: { lastAt: now - 3 * DAYS } })).toMatch(
      /^Not yet: the last backup is from \d{4}-\d{2}-\d{2}, more than two days ago/,
    );
    expect(hintOf("backups", { ...facts, backup: { lastAt: null } })).toBe(
      "Not yet: no backup has been made.",
    );
    expect(hintOf("backups", facts)).toBe("");
  });
});
