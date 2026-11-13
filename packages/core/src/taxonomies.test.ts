import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import {
  createTerm,
  deleteTerm,
  ensureDefaultTaxonomies,
  loadTaxonomy,
  updateTerm,
} from "./taxonomies.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: categories and tags`, () => {
    let db: TestDb;
    let siteId = "";
    let editor: Actor;
    let author: Actor;

    const terms = async (key: string) => (await loadTaxonomy(db.runner, siteId, key))!.terms;
    const termBySlug = async (key: string, slug: string) =>
      (await terms(key)).find((t) => t.slug === slug)!;
    const addPost = async (title: string) => {
      const id = newId();
      await db.run(
        `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, created_at, updated_at)
         values (?, ?, 'post', 'published', ?, ?, ?, '{}', '{"version":1,"blocks":[]}', '', '', '{}', '{}', ?, ?)`,
        [id, siteId, title, `blog/${title}`, editor.userId, T, T],
      );
      return id;
    };
    const entryTerms = async (entryId: string) =>
      (
        await db.run(
          "select t.slug from entry_terms et join terms t on t.id = et.term_id where et.entry_id = ? order by t.slug",
          [entryId],
        )
      ).map((r) => String(r["slug"]));

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
      editor = actorOf(setup.userId, "editor");
      author = actorOf(setup.userId, "author");
    });
    afterEach(async () => {
      await db.close();
    });

    test("a new site has Categories with Uncategorised, and Tags", async () => {
      const categories = await loadTaxonomy(db.runner, siteId, "category");
      expect(categories).toMatchObject({ label: "Categories", hierarchical: true });
      expect(categories!.terms.map((t) => t.slug)).toEqual(["uncategorised"]);
      expect(await loadTaxonomy(db.runner, siteId, "tag")).toMatchObject({
        label: "Tags",
        hierarchical: false,
        terms: [],
      });
      expect(await loadTaxonomy(db.runner, siteId, "nope")).toBeNull();
    });

    test("setting up the defaults again changes nothing", async () => {
      await ensureDefaultTaxonomies(db.runner, siteId);
      await ensureDefaultTaxonomies(db.runner, siteId);
      expect((await db.run("select 1 from taxonomies")).length).toBe(2);
      expect((await terms("category")).length).toBe(1);
    });

    test("making a term: the address comes from the name and is made unique", async () => {
      const a = await createTerm(db.runner, editor, siteId, "category", { name: "News & Views" });
      expect(a).toMatchObject({ ok: true, slug: "news-views" });
      const b = await createTerm(db.runner, editor, siteId, "category", { name: "News views" });
      expect(b).toMatchObject({ ok: true, slug: "news-views-2" });
      expect(
        await createTerm(db.runner, editor, siteId, "category", { name: "X", slug: "news-views" }),
      ).toMatchObject({ ok: false, code: "slug_taken" });
      expect(
        await createTerm(db.runner, editor, siteId, "tag", { name: "News views" }),
      ).toMatchObject({ ok: true, slug: "news-views" });
    });

    test("names and addresses in other scripts and with accents are kept", async () => {
      expect(
        await createTerm(db.runner, editor, siteId, "category", { name: "समाचार" }),
      ).toMatchObject({ ok: true, slug: "समाचार" });
      expect(
        await createTerm(db.runner, editor, siteId, "tag", { name: "Café Münster" }),
      ).toMatchObject({ ok: true, slug: "café-münster" });
      // An address typed by hand may be in any script too, but it must be lower case and composed.
      expect(
        await createTerm(db.runner, editor, siteId, "tag", { name: "x", slug: "नमस्ते-दुनिया" }),
      ).toMatchObject({ ok: true, slug: "नमस्ते-दुनिया" });
      expect(
        await createTerm(db.runner, editor, siteId, "tag", { name: "y", slug: "Café" }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect(
        await createTerm(db.runner, editor, siteId, "tag", { name: "z", slug: "café" }),
      ).toMatchObject({ ok: false, code: "invalid" });
    });

    test("bad input is refused", async () => {
      const bad = (input: object, key = "category") =>
        createTerm(db.runner, editor, siteId, key, input);
      expect(await bad({ name: "  " })).toMatchObject({ ok: false, code: "invalid" });
      expect(await bad({ name: "x".repeat(81) })).toMatchObject({ ok: false, code: "invalid" });
      expect(await bad({ name: "x", slug: "Bad Slug" })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await bad({ name: "x", description: "d".repeat(501) })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await bad({ name: "x", parentId: newId() })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await bad({ name: "x" }, "missing")).toMatchObject({ ok: false, code: "not_found" });
    });

    test("only people who edit all content may change them", async () => {
      expect(await createTerm(db.runner, author, siteId, "tag", { name: "x" })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      const made = await createTerm(db.runner, editor, siteId, "tag", { name: "x" });
      if (!made.ok) throw new Error("setup");
      expect(await updateTerm(db.runner, author, siteId, made.id, { name: "y" })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await deleteTerm(db.runner, author, siteId, made.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    });

    test("categories form a tree; tags have no parent; a loop is refused", async () => {
      const a = await createTerm(db.runner, editor, siteId, "category", { name: "A" });
      if (!a.ok) throw new Error("setup");
      const b = await createTerm(db.runner, editor, siteId, "category", {
        name: "B",
        parentId: a.id,
      });
      if (!b.ok) throw new Error("setup");
      expect((await termBySlug("category", "b")).parentId).toBe(a.id);
      expect(await updateTerm(db.runner, editor, siteId, a.id, { parentId: b.id })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await updateTerm(db.runner, editor, siteId, a.id, { parentId: a.id })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      const tag = await createTerm(db.runner, editor, siteId, "tag", { name: "t" });
      expect(
        await createTerm(db.runner, editor, siteId, "tag", {
          name: "u",
          parentId: tag.ok ? tag.id : "",
        }),
      ).toMatchObject({ ok: false, code: "invalid" });
      // A parent from the other list is not accepted.
      expect(
        await updateTerm(db.runner, editor, siteId, a.id, { parentId: tag.ok ? tag.id : "" }),
      ).toMatchObject({ ok: false, code: "invalid" });
    });

    test("changing a term: name, address, description and parent; the address stays unique", async () => {
      const a = await createTerm(db.runner, editor, siteId, "category", { name: "A" });
      const b = await createTerm(db.runner, editor, siteId, "category", { name: "B" });
      if (!a.ok || !b.ok) throw new Error("setup");
      expect(
        await updateTerm(db.runner, editor, siteId, a.id, {
          name: "Alpha",
          slug: "alpha",
          description: "First",
          parentId: b.id,
        }),
      ).toMatchObject({ ok: true, slug: "alpha" });
      expect(await termBySlug("category", "alpha")).toMatchObject({
        name: "Alpha",
        description: "First",
        parentId: b.id,
      });
      expect(await updateTerm(db.runner, editor, siteId, a.id, { parentId: null })).toMatchObject({
        ok: true,
      });
      expect((await termBySlug("category", "alpha")).parentId).toBeNull();
      expect(await updateTerm(db.runner, editor, siteId, b.id, { slug: "alpha" })).toMatchObject({
        ok: false,
        code: "slug_taken",
      });
      expect(await updateTerm(db.runner, editor, siteId, newId(), { name: "x" })).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });

    test("Uncategorised can be renamed but not moved, re-addressed or deleted", async () => {
      const u = await termBySlug("category", "uncategorised");
      expect(await updateTerm(db.runner, editor, siteId, u.id, { name: "General" })).toMatchObject({
        ok: true,
      });
      expect(await updateTerm(db.runner, editor, siteId, u.id, { slug: "general" })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await deleteTerm(db.runner, editor, siteId, u.id)).toMatchObject({
        ok: false,
        code: "invalid",
      });
    });

    test("the count shows posts that carry a term, and leaves out the trash", async () => {
      const t = await createTerm(db.runner, editor, siteId, "tag", { name: "T" });
      if (!t.ok) throw new Error("setup");
      const one = await addPost("one");
      const two = await addPost("two");
      for (const id of [one, two])
        await db.run("insert into entry_terms (entry_id, term_id, position) values (?, ?, 0)", [
          id,
          t.id,
        ]);
      expect((await termBySlug("tag", "t")).count).toBe(2);
      await db.run("update entries set status = 'trash' where id = ?", [two]);
      expect((await termBySlug("tag", "t")).count).toBe(1);
    });

    test("deleting a category moves posts that had only it to Uncategorised, and lifts its children", async () => {
      const a = await createTerm(db.runner, editor, siteId, "category", { name: "A" });
      const b = await createTerm(db.runner, editor, siteId, "category", { name: "B" });
      if (!a.ok || !b.ok) throw new Error("setup");
      const child = await createTerm(db.runner, editor, siteId, "category", {
        name: "Child",
        parentId: a.id,
      });
      if (!child.ok) throw new Error("setup");
      const only = await addPost("only");
      const both = await addPost("both");
      const link = (entry: string, term: string) =>
        db.run("insert into entry_terms (entry_id, term_id, position) values (?, ?, 0)", [
          entry,
          term,
        ]);
      await link(only, a.id);
      await link(both, a.id);
      await link(both, b.id);
      expect(await deleteTerm(db.runner, editor, siteId, a.id)).toMatchObject({
        ok: true,
        moved: 1,
      });
      expect(await entryTerms(only)).toEqual(["uncategorised"]);
      expect(await entryTerms(both)).toEqual(["b"]);
      expect((await termBySlug("category", "child")).parentId).toBeNull();
      expect((await terms("category")).some((t) => t.slug === "a")).toBe(false);
      // Nothing of the deleted term is left behind.
      expect(await db.run("select 1 from entry_terms where term_id = ?", [a.id])).toHaveLength(0);
    });

    test("deleting a tag just takes it off the posts", async () => {
      const t = await createTerm(db.runner, editor, siteId, "tag", { name: "T" });
      if (!t.ok) throw new Error("setup");
      const post = await addPost("p");
      await db.run("insert into entry_terms (entry_id, term_id, position) values (?, ?, 0)", [
        post,
        t.id,
      ]);
      expect(await deleteTerm(db.runner, editor, siteId, t.id)).toMatchObject({
        ok: true,
        moved: 0,
      });
      expect(await entryTerms(post)).toEqual([]);
    });

    test("a term of another site cannot be reached", async () => {
      const t = await createTerm(db.runner, editor, siteId, "tag", { name: "T" });
      if (!t.ok) throw new Error("setup");
      expect(await deleteTerm(db.runner, editor, newId(), t.id)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });
  });
}
