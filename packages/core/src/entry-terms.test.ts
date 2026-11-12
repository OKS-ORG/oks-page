import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { loadEntryTerms, setEntryTerms } from "./entry-terms.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import { createTerm, deleteTerm, loadTaxonomy } from "./taxonomies.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: choosing categories and tags for a post`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let post = "";
    let page = "";

    const addEntry = async (type: string, title: string, authorId: string) => {
      const id = newId();
      await db.run(
        `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, created_at, updated_at)
         values (?, ?, ?, 'draft', ?, ?, ?, '{}', '{"version":1,"blocks":[]}', '', '', '{}', '{}', ?, ?)`,
        [id, siteId, type, title, `${type}-${title}`, authorId, T, T],
      );
      return id;
    };
    const slugsOf = async (ids: string[]) => {
      const all = (await loadTaxonomy(db.runner, siteId, "category"))!.terms;
      return ids.map((id) => all.find((t) => t.id === id)!.slug);
    };

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
      admin = actorOf(setup.userId, "administrator");
      post = await addEntry("post", "p", setup.userId);
      page = await addEntry("page", "g", setup.userId);
    });
    afterEach(async () => {
      await db.close();
    });

    const categoryId = async (name: string) => {
      const made = await createTerm(db.runner, admin, siteId, "category", { name });
      if (!made.ok) throw new Error("setup");
      return made.id;
    };

    test("a post with no choice gets Uncategorised", async () => {
      const result = await setEntryTerms(db.runner, admin, siteId, post, {
        categoryIds: [],
        tags: [],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(await slugsOf(result.categoryIds)).toEqual(["uncategorised"]);
      expect(result.tags).toEqual([]);
    });

    test("categories and tags are saved, a new tag is made, an old one is reused, and a second save replaces the first", async () => {
      const news = await categoryId("News");
      const sports = await categoryId("Sports");
      const first = await setEntryTerms(db.runner, admin, siteId, post, {
        categoryIds: [news, sports, news],
        tags: ["Garden", " garden ", "Fresh Air", ""],
      });
      if (!first.ok) throw new Error(first.message);
      expect(first.categoryIds).toEqual([news, sports]);
      expect(first.tags.map((t) => t.name)).toEqual(["Garden", "Fresh Air"]);
      const second = await setEntryTerms(db.runner, admin, siteId, post, {
        categoryIds: [sports],
        tags: ["garden"],
      });
      if (!second.ok) throw new Error(second.message);
      expect(second.categoryIds).toEqual([sports]);
      // The tag "Garden" already existed: it is reused, not made twice.
      expect(second.tags).toEqual([{ id: first.tags[0]!.id, name: "Garden" }]);
      expect(
        (await loadTaxonomy(db.runner, siteId, "tag"))!.terms.map((t) => t.slug).sort(),
      ).toEqual(["fresh-air", "garden"]);
      expect(await loadEntryTerms(db.runner, siteId, post)).toEqual({
        categoryIds: second.categoryIds,
        tags: second.tags,
      });
    });

    test("bad choices are refused and nothing changes", async () => {
      const news = await categoryId("News");
      await setEntryTerms(db.runner, admin, siteId, post, { categoryIds: [news], tags: ["a"] });
      const before = await loadEntryTerms(db.runner, siteId, post);
      const tagId = before.tags[0]!.id;
      const bad = (input: { categoryIds: unknown; tags: unknown }) =>
        setEntryTerms(db.runner, admin, siteId, post, input);
      expect(await bad({ categoryIds: [tagId], tags: [] })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await bad({ categoryIds: [newId()], tags: [] })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await bad({ categoryIds: "x", tags: [] })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await bad({ categoryIds: [], tags: [5] })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(
        await bad({ categoryIds: [], tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect(await bad({ categoryIds: [], tags: ["x".repeat(81)] })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await loadEntryTerms(db.runner, siteId, post)).toEqual(before);
    });

    test("a page has no categories or tags", async () => {
      expect(
        await setEntryTerms(db.runner, admin, siteId, page, { categoryIds: [], tags: [] }),
      ).toMatchObject({ ok: false, code: "invalid" });
    });

    test("an author may do it for their own post only; an unknown post is not found", async () => {
      const author = actorOf(newId(), "author");
      expect(
        await setEntryTerms(db.runner, author, siteId, post, { categoryIds: [], tags: [] }),
      ).toMatchObject({ ok: false, code: "forbidden" });
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, 'Au', 'au@example.com', ?, ?)",
        [author.userId, T, T],
      );
      const own = await addEntry("post", "own", author.userId);
      expect(
        await setEntryTerms(db.runner, author, siteId, own, { categoryIds: [], tags: ["mine"] }),
      ).toMatchObject({ ok: true });
      expect(
        await setEntryTerms(db.runner, admin, siteId, newId(), { categoryIds: [], tags: [] }),
      ).toMatchObject({ ok: false, code: "not_found" });
    });

    test("after the chosen category is deleted, the post shows Uncategorised", async () => {
      const news = await categoryId("News");
      await setEntryTerms(db.runner, admin, siteId, post, { categoryIds: [news], tags: [] });
      await deleteTerm(db.runner, admin, siteId, news);
      const now = await loadEntryTerms(db.runner, siteId, post);
      expect(await slugsOf(now.categoryIds)).toEqual(["uncategorised"]);
    });
  });
}
