import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { loadMenu, loadMenuChoices, MENU_LIMITS, saveMenu, type MenuItem } from "./menus.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import { createTerm } from "./taxonomies.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};
const url = (id: string, label: string, address = "/x", children: MenuItem[] = []): MenuItem => ({
  id,
  label,
  kind: "url",
  url: address,
  children,
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the navigation menus`, () => {
    let db: TestDb;
    let siteId = "";
    let editor: Actor;
    let author: Actor;
    let aboutId = "";

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
          starterContent: true,
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      editor = actorOf(setup.userId, "editor");
      author = actorOf(setup.userId, "author");
      aboutId = String((await db.run("select id from entries where slug = 'about'"))[0]!["id"]);
    });
    afterEach(async () => {
      await db.close();
    });

    const save = (items: unknown, updatedAt: unknown = 0, who = editor, place = "primary") =>
      saveMenu(db.runner, who, siteId, place, { items, updatedAt });

    test("a menu that was never saved is empty and has version 0", async () => {
      expect(await loadMenu(db.runner, siteId, "primary")).toEqual({
        place: "primary",
        label: "Header menu",
        items: [],
        updatedAt: 0,
      });
    });

    test("a saved tree comes back as it was saved, with the version to send next time", async () => {
      const tree = [
        { id: "a", label: "About", kind: "entry", entryId: aboutId, children: [] },
        url("b", "Shop", "https://shop.example.com", [url("c", "Mugs", "/mugs")]),
        url("d", "Mail", "mailto:hi@example.com"),
      ];
      const first = await save(tree);
      if (!first.ok) throw new Error(first.message);
      const loaded = await loadMenu(db.runner, siteId, "primary");
      expect(loaded.items).toEqual(tree);
      expect(loaded.updatedAt).toBe(first.updatedAt);
      expect(loaded.updatedAt).toBeGreaterThan(0);
      const second = await save([url("a", "Only")], first.updatedAt);
      expect(second.ok).toBe(true);
      expect((await loadMenu(db.runner, siteId, "primary")).items).toHaveLength(1);
      expect(await db.run("select 1 from menus")).toHaveLength(1);
      // The two places are separate.
      expect((await loadMenu(db.runner, siteId, "footer")).items).toEqual([]);
    });

    test("a save from an old version is refused and nothing changes", async () => {
      const first = await save([url("a", "One")]);
      if (!first.ok) throw new Error(first.message);
      // Someone else saves.
      const theirs = await save([url("a", "Theirs")], first.updatedAt);
      if (!theirs.ok) throw new Error(theirs.message);
      expect(await save([url("a", "Mine")], first.updatedAt)).toMatchObject({
        ok: false,
        code: "conflict",
      });
      // A second "first save" of a menu that now exists is a conflict too.
      expect(await save([url("a", "Mine")], 0)).toMatchObject({ ok: false, code: "conflict" });
      expect((await loadMenu(db.runner, siteId, "primary")).items[0]!.label).toBe("Theirs");
    });

    test("only people who manage menus may save, and only the two places exist", async () => {
      expect(await save([url("a", "One")], 0, author)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await save([url("a", "One")], 0, editor, "sidebar")).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(await db.run("select 1 from menus")).toHaveLength(0);
    });

    test("bad menus are refused with a reason, and nothing is saved", async () => {
      const bad = async (items: unknown, version: unknown = 0) =>
        expect(await save(items, version)).toMatchObject({ ok: false, code: "invalid" });
      await bad("nope");
      await bad([null]);
      await bad([url("a", "  ")]);
      await bad([url("a", "x".repeat(MENU_LIMITS.label + 1))]);
      await bad([url("a", "A"), url("a", "B")]); // the same id twice
      await bad([url("bad id!", "A")]);
      await bad([url("a", "A", "javascript:alert(1)")]);
      await bad([url("a", "A", "//evil.example.com")]);
      await bad([url("a", "A", "data:text/html,hi")]);
      await bad([{ id: "a", label: "A", kind: "entry", entryId: newId(), children: [] }]);
      await bad([{ id: "a", label: "A", kind: "term", termId: newId(), children: [] }]);
      await bad([{ id: "a", label: "A", kind: "wat", children: [] }]);
      await bad([url("a", "A", "/x", "oops" as never)]);
      await bad([
        url("a", "1", "/x", [url("b", "2", "/x", [url("c", "3", "/x", [url("d", "4")])])]),
      ]);
      await bad("x", "not a number");
      await bad(Array.from({ length: MENU_LIMITS.items + 1 }, (_, i) => url(`i${i}`, `I${i}`)));
      expect(await db.run("select 1 from menus")).toHaveLength(0);
    });

    test("three levels and the biggest menu are accepted; an item in the trash cannot be added", async () => {
      expect(
        await save([url("a", "1", "/x", [url("b", "2", "/x", [url("c", "3")])])]),
      ).toMatchObject({ ok: true });
      expect(
        await save(
          Array.from({ length: MENU_LIMITS.items }, (_, i) => url(`i${i}`, `I${i}`)),
          (await loadMenu(db.runner, siteId, "primary")).updatedAt,
        ),
      ).toMatchObject({ ok: true });
      await db.run("update entries set status = 'trash' where id = ?", [aboutId]);
      expect(
        await save(
          [{ id: "a", label: "A", kind: "entry", entryId: aboutId, children: [] }],
          (await loadMenu(db.runner, siteId, "primary")).updatedAt,
        ),
      ).toMatchObject({ ok: false, code: "invalid" });
    });

    test("an item may point at a category or tag", async () => {
      const made = await createTerm(db.runner, editor, siteId, "category", { name: "News" });
      if (!made.ok) throw new Error("setup");
      expect(
        await save([{ id: "a", label: "News", kind: "term", termId: made.id, children: [] }]),
      ).toMatchObject({ ok: true });
    });

    test("the choices are the published pages and posts and every category and tag", async () => {
      await db.run("update entries set status = 'draft' where slug = 'contact'");
      const choices = await loadMenuChoices(db.runner, siteId);
      expect(choices.entries.map((e) => e.slug).sort()).toEqual([
        "about",
        "blog/hello-world",
        "home",
      ]);
      expect(choices.terms.map((t) => `${t.kind}/${t.slug}`)).toEqual(["category/uncategorised"]);
      await createTerm(db.runner, editor, siteId, "tag", { name: "Garden" });
      expect(
        (await loadMenuChoices(db.runner, siteId)).terms.map((t) => `${t.kind}/${t.slug}`),
      ).toEqual(["category/uncategorised", "tag/garden"]);
    });
  });
}
