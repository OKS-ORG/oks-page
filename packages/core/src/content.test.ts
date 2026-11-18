// Entries as the admin works with them, on SQLite and PostgreSQL: who may do what, the repairs, the stored HTML, the
// revision rule and the addresses.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createDraft,
  listEntries,
  loadForEdit,
  saveContent,
  slugFromTitle,
  type Actor,
} from "./content.js";
import { searchAdminEntries } from "./admin-search.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const text = (value: string) => ({ type: "text", text: value, styles: {} });
const para = (value: string, id = newId()) => ({
  id,
  type: "paragraph",
  props: {},
  content: [text(value)],
  children: [],
});

const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: entries in the admin`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor; // administrator
    let eve: Actor; // editor
    let bob: Actor; // author
    let cara: Actor; // contributor
    let sam: Actor; // subscriber

    const user = async (name: string) => {
      const id = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [id, name, `${name.toLowerCase()}@example.com`, T, T],
      );
      return id;
    };
    const draft = async (actor: Actor, title: string, type = "page") => {
      const made = await createDraft(db.runner, actor, siteId, { type, title });
      if (!made.ok) throw new Error(made.message);
      return made;
    };
    const input = (over = {}) => ({
      title: "T",
      slugPart: "t",
      status: "draft",
      blocks: [para("hello")],
      revision: 1,
      ...over,
    });

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
      eve = actorOf(await user("Eve"), "editor");
      bob = actorOf(await user("Bob"), "author");
      cara = actorOf(await user("Cara"), "contributor");
      sam = actorOf(await user("Sam"), "subscriber");
    });
    afterEach(async () => db.close());

    test("slugs are made from the title: lower case, hyphens, accents kept (more in slug.test.ts)", () => {
      expect(slugFromTitle("Hello, World!")).toBe("hello-world");
      expect(slugFromTitle("Crème brûlée  recipe")).toBe("crème-brûlée-recipe");
      expect(slugFromTitle("???")).toBe("untitled");
      expect(slugFromTitle("Anna's Garden")).toBe("annas-garden");
    });

    test("a new draft has the address made from its title; a clash adds -2, -3; posts go under /blog", async () => {
      const first = await draft(anna, "My Page");
      expect(first).toMatchObject({ slug: "my-page", revision: 1 });
      expect((await draft(anna, "My Page")).slug).toBe("my-page-2");
      expect((await draft(anna, "My Page")).slug).toBe("my-page-3");
      expect((await draft(anna, "My Post", "post")).slug).toBe("blog/my-post");
      expect((await draft(anna, "Admin")).slug).toBe("admin-page");
      const row = (await db.run("select status, body from entries where id = ?", [first.id]))[0]!;
      expect(row["status"]).toBe("draft");
    });

    test("who may add content: administrators, editors, authors and contributors, not subscribers", async () => {
      for (const who of [anna, eve, bob, cara])
        expect((await createDraft(db.runner, who, siteId, { type: "page", title: "x" })).ok).toBe(
          true,
        );
      const refused = await createDraft(db.runner, sam, siteId, { type: "page", title: "x" });
      expect(refused).toMatchObject({ ok: false, code: "forbidden" });
      expect(
        await createDraft(db.runner, anna, siteId, { type: "page", title: "  " }),
      ).toMatchObject({ code: "invalid", field: "title" });
      expect(
        await createDraft(db.runner, anna, siteId, { type: "recipe", title: "x" }),
      ).toMatchObject({ code: "no_such_type" });
    });

    test("loading for edit: your own, or anyone's for an editor; not someone else's for an author", async () => {
      const mine = await draft(bob, "Bob's page");
      const loaded = await loadForEdit(db.runner, bob, siteId, mine.id);
      expect(loaded).toMatchObject({
        ok: true,
        entry: { title: "Bob's page", slugPart: "bobs-page", prefix: "", revision: 1, blocks: [] },
      });
      const post = await draft(anna, "Hello", "post");
      expect(await loadForEdit(db.runner, anna, siteId, post.id)).toMatchObject({
        entry: { slugPart: "hello", prefix: "blog/" },
      });
      expect(await loadForEdit(db.runner, eve, siteId, mine.id)).toMatchObject({ ok: true });
      const annas = await draft(anna, "Anna's");
      expect(await loadForEdit(db.runner, bob, siteId, annas.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await loadForEdit(db.runner, anna, siteId, newId())).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });

    test("saving stores the title, the address, the blocks, and the HTML and text our writer makes", async () => {
      const made = await draft(anna, "Draft");
      const saved = await saveContent(
        db.runner,
        anna,
        siteId,
        made.id,
        input({ title: "About <us>", slugPart: "about-us", blocks: [para("Hello & welcome")] }),
      );
      expect(saved).toMatchObject({
        ok: true,
        revision: 2,
        slug: "about-us",
        repairs: [],
        skippedBlocks: [],
      });
      const row = (
        await db.run(
          "select title, slug, html, plain_text, revision, body from entries where id = ?",
          [made.id],
        )
      )[0]!;
      expect(row["title"]).toBe("About <us>");
      expect(row["slug"]).toBe("about-us");
      expect(row["html"]).toBe("<p>Hello &amp; welcome</p>");
      expect(row["plain_text"]).toBe("Hello & welcome");
      expect(Number(row["revision"])).toBe(2);
      const body = kind === "sqlite" ? JSON.parse(String(row["body"])) : row["body"];
      expect(body.version).toBe(1);
      expect(body.blocks).toHaveLength(1);
    });

    test("hostile blocks are repaired before they are stored, and the person is told how many things were fixed", async () => {
      const made = await draft(anna, "Hostile");
      const saved = await saveContent(
        db.runner,
        anna,
        siteId,
        made.id,
        input({
          blocks: [
            {
              id: "a",
              type: "paragraph",
              props: {},
              content: [
                { type: "link", text: "x", href: "javascript:alert(1)" },
                { type: "text", text: "y", styles: { color: 'red" onmouseover="alert(1)' } },
              ],
              children: [],
            },
            {
              id: "a",
              type: "image",
              props: { src: "javascript:alert(1)", alt: "i" },
              content: null,
              children: [],
            },
            { id: "p", type: "pricing-card", props: {}, content: null, children: [] },
          ],
        }),
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.repairs.length).toBeGreaterThan(0);
      expect(saved.skippedBlocks).toEqual(["pricing-card"]);
      const row = (await db.run("select html, body from entries where id = ?", [made.id]))[0]!;
      const stored = String(row["html"]) + JSON.stringify(row["body"]);
      expect(stored).not.toContain("javascript:");
      expect(stored).not.toContain("onmouseover");
    });

    test("AS-01: the admin search finds pages and posts by every word of the title, in any case, with % and _ taken literally", async () => {
      await draft(anna, "Summer Sale Plans");
      await draft(anna, "Winter plans", "post");
      await draft(anna, "100% real");
      await draft(anna, "100 percent real");
      await draft(anna, "a_b");
      await draft(anna, "axb");
      const find = async (q: string, who = anna) =>
        (await searchAdminEntries(db.runner, who, siteId, q)).map((h) => `${h.type}:${h.title}`);
      expect((await find("plans")).sort()).toEqual(["page:Summer Sale Plans", "post:Winter plans"]);
      expect(await find("SUMMER plans")).toEqual(["page:Summer Sale Plans"]);
      expect(await find("100%")).toEqual(["page:100% real"]);
      expect(await find("a_b")).toEqual(["page:a_b"]);
      expect(await find("x")).toEqual([]);
      expect(await find("  ")).toEqual([]);
      expect(await find("nothing like it")).toEqual([]);
    });

    test("AS-02: the admin search leaves out the trash, shows eight at most, and shows each person only what they may edit", async () => {
      const gone = await draft(anna, "Findme gone");
      await db.run(`update entries set status = 'trash' where id = ?`, [gone.id]);
      await draft(bob, "Findme by Bob");
      await draft(eve, "Findme by Eve");
      const titles = async (who: Actor) =>
        (await searchAdminEntries(db.runner, who, siteId, "findme")).map((h) => h.title).sort();
      expect(await titles(anna)).toEqual(["Findme by Bob", "Findme by Eve"]);
      expect(await titles(eve)).toEqual(["Findme by Bob", "Findme by Eve"]);
      expect(await titles(bob)).toEqual(["Findme by Bob"]);
      expect(await titles(sam)).toEqual([]);
      for (let i = 0; i < 10; i++) await draft(anna, `Many ${i}`);
      expect(await searchAdminEntries(db.runner, anna, siteId, "many")).toHaveLength(8);
    });

    test("CT-60: a save that removes a block leaves a line in the log, a clean save does not", async () => {
      const made = await draft(anna, "Logged");
      const count = async () =>
        (
          await db.run(
            `select detail from audit_log where action = 'content.repaired' and target_id = ?`,
            [made.id],
          )
        ).length;
      const clean = await saveContent(
        db.runner,
        anna,
        siteId,
        made.id,
        input({ blocks: [para("ok")] }),
      );
      expect(clean.ok).toBe(true);
      expect(await count()).toBe(0);
      const revision = clean.ok ? clean.revision : 0;
      const bad = await saveContent(
        db.runner,
        anna,
        siteId,
        made.id,
        input({
          revision,
          blocks: [
            para("ok"),
            { id: "x", type: "Not A Block", props: {}, content: null, children: [] },
          ],
        }),
      );
      expect(bad.ok).toBe(true);
      expect(await count()).toBe(1);
      const row = (
        await db.run(
          `select detail from audit_log where action = 'content.repaired' and target_id = ?`,
          [made.id],
        )
      )[0]!;
      const detail = typeof row["detail"] === "string" ? JSON.parse(row["detail"]) : row["detail"];
      expect(detail).toEqual({ removed: 1, repairs: ["removed_invalid_block"] });
    });

    test("publishing sets the publish time once; saving again keeps it", async () => {
      const made = await draft(anna, "News");
      const first = new Date(1_800_000_000_000);
      await saveContent(db.runner, anna, siteId, made.id, input({ status: "published" }), () =>
        first.getTime(),
      );
      const read = async () =>
        (await db.run("select published_at, status from entries where id = ?", [made.id]))[0]!;
      const at = (v: unknown) => new Date(v instanceof Date ? v : Number(v)).getTime();
      expect((await read())["status"]).toBe("published");
      expect(at((await read())["published_at"])).toBe(first.getTime());
      await saveContent(
        db.runner,
        anna,
        siteId,
        made.id,
        input({ status: "published", revision: 2 }),
        () => first.getTime() + 5000,
      );
      expect(at((await read())["published_at"])).toBe(first.getTime());
    });

    test("who may publish: editors anything, authors their own, contributors nothing; others' entries stay closed", async () => {
      const bobs = await draft(bob, "Bobs");
      const caras = await draft(cara, "Caras");
      expect(
        await saveContent(db.runner, bob, siteId, bobs.id, input({ status: "published" })),
      ).toMatchObject({ ok: true });
      expect(
        await saveContent(db.runner, cara, siteId, caras.id, input({ status: "published" })),
      ).toMatchObject({ ok: false, code: "forbidden", field: "status" });
      expect(
        await saveContent(
          db.runner,
          cara,
          siteId,
          caras.id,
          input({ status: "draft", slugPart: "caras" }),
        ),
      ).toMatchObject({ ok: true });
      expect(
        await saveContent(
          db.runner,
          eve,
          siteId,
          caras.id,
          input({ status: "published", slugPart: "caras-news", revision: 2 }),
        ),
      ).toMatchObject({ ok: true });
      expect(
        await saveContent(
          db.runner,
          bob,
          siteId,
          caras.id,
          input({ revision: 3, slugPart: "caras" }),
        ),
      ).toMatchObject({ ok: false, code: "forbidden" });
      expect(
        await saveContent(
          db.runner,
          sam,
          siteId,
          bobs.id,
          input({ revision: 2, slugPart: "bobs" }),
        ),
      ).toMatchObject({ ok: false, code: "forbidden" });
    });

    test("a save from an old revision is refused and says what the current one is", async () => {
      const made = await draft(anna, "Race");
      expect(await saveContent(db.runner, anna, siteId, made.id, input())).toMatchObject({
        ok: true,
        revision: 2,
      });
      expect(
        await saveContent(db.runner, eve, siteId, made.id, input({ slugPart: "race-2" })),
      ).toMatchObject({
        ok: false,
        code: "conflict",
        currentRevision: 2,
      });
    });

    test("20 saves from the same revision at once: exactly one wins", async () => {
      const made = await draft(anna, "Many");
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          saveContent(
            db.runner,
            anna,
            siteId,
            made.id,
            input({ title: `Version ${i}`, slugPart: "many" }),
          ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.code === "conflict")).toHaveLength(19);
    });

    test("address rules: a plain slug, not reserved, not taken; keeping your own is fine; a trashed entry's is free", async () => {
      const a = await draft(anna, "First");
      const b = await draft(anna, "Second");
      const save = (id: string, slugPart: string, revision = 1) =>
        saveContent(db.runner, anna, siteId, id, input({ slugPart, revision }));
      expect(await save(a.id, "Has Space")).toMatchObject({ code: "invalid", field: "slug" });
      expect(await save(a.id, "double--hyphen")).toMatchObject({ code: "invalid" });
      expect(await save(a.id, "admin")).toMatchObject({
        code: "invalid",
        message: expect.stringContaining("kept for the site"),
      });
      expect(await save(a.id, "second")).toMatchObject({ code: "slug_taken", field: "slug" });
      expect(await save(a.id, "first")).toMatchObject({ ok: true });
      await db.run("update entries set status = 'trash' where id = ?", [b.id]);
      expect(await save(a.id, "second", 2)).toMatchObject({ ok: true });
    });

    test("the list: everything for an editor, only your own for an author, nothing for a subscriber; trash is left out", async () => {
      await draft(anna, "By Anna");
      const bobs = await draft(bob, "By Bob");
      const gone = await draft(bob, "Gone");
      await db.run("update entries set status = 'trash' where id = ?", [gone.id]);
      await draft(anna, "A post", "post");
      const titles = async (who: Actor, type = "page") =>
        (await listEntries(db.runner, who, siteId, type)).map((e) => e.title).sort();
      expect(await titles(eve)).toEqual(["By Anna", "By Bob"]);
      expect(await titles(bob)).toEqual(["By Bob"]);
      expect(await titles(sam)).toEqual([]);
      expect(await titles(anna, "post")).toEqual(["A post"]);
      const listed = (await listEntries(db.runner, bob, siteId, "page"))[0]!;
      expect(listed).toMatchObject({
        id: bobs.id,
        status: "draft",
        authorName: "Bob",
        slug: "by-bob",
      });
      expect(Number.isNaN(Date.parse(listed.updatedAt))).toBe(false);
    });
  });
}
