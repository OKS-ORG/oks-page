import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { loadEntrySeo, loadFeedPosts, setEntrySeo } from "./entry-seo.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SEO_DESCRIPTION_MAX } from "./seo-meta.js";
import { runSetup } from "./setup.js";
import { loadSitemapUrls } from "./sitemap.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the SEO box and the feeds`, () => {
    let db: TestDb;
    let siteId = "";
    let userId = "";
    let admin: Actor;

    const addPost = async (
      title: string,
      opts: { status?: string; seo?: object; at?: number; text?: string; type?: string } = {},
    ) => {
      const id = newId();
      await db.run(
        `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, published_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, '{}', '{"version":1,"blocks":[]}', ?, ?, ?, '{}', ?, ?, ?)`,
        [
          id,
          siteId,
          opts.type ?? "post",
          opts.status ?? "published",
          title,
          `blog/${id.toLowerCase()}`,
          userId,
          opts.text ?? `${title} text`,
          `<p>${title} body</p>`,
          JSON.stringify(opts.seo ?? {}),
          new Date(opts.at ?? 5_000),
          T,
          new Date(opts.at ?? 5_000),
        ],
      );
      return id;
    };
    const category = async (slug: string, parent: string | null = null) => {
      const id = newId();
      const tax = String(
        (await db.run("select id from taxonomies where key = 'category'"))[0]!["id"],
      );
      await db.run(
        "insert into terms (id, taxonomy_id, parent_id, slug, name, description) values (?, ?, ?, ?, ?, '')",
        [id, tax, parent, slug, slug.toUpperCase()],
      );
      return id;
    };
    const link = (entry: string, term: string) =>
      db.run("insert into entry_terms (entry_id, term_id, position) values (?, ?, 0)", [
        entry,
        term,
      ]);

    /** The stored value as an object: PostgreSQL gives it parsed, SQLite as text. */
    const seoOf = async (id: string) => {
      const raw = (await db.run("select seo from entries where id = ?", [id]))[0]!["seo"];
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    };

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
          siteName: "S",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      userId = setup.userId;
      admin = actorOf(userId, "administrator");
    });
    afterEach(async () => {
      await db.close();
    });

    describe("the SEO box", () => {
      test("nothing is set at first; a description and the switch are saved, trimmed, and cleared again", async () => {
        const id = await addPost("Hello");
        expect(await loadEntrySeo(db.runner, admin, siteId, id)).toMatchObject({
          ok: true,
          seo: { description: "", noindex: false },
        });
        const saved = await setEntrySeo(db.runner, admin, siteId, id, {
          description: "  Fresh bread, daily.  ",
          noindex: true,
        });
        expect(saved).toMatchObject({
          ok: true,
          seo: { description: "Fresh bread, daily.", noindex: true },
        });
        expect(await loadEntrySeo(db.runner, admin, siteId, id)).toMatchObject({
          seo: { description: "Fresh bread, daily.", noindex: true },
        });
        // Only what is sent changes.
        await setEntrySeo(db.runner, admin, siteId, id, { noindex: false });
        expect(await loadEntrySeo(db.runner, admin, siteId, id)).toMatchObject({
          seo: { description: "Fresh bread, daily.", noindex: false },
        });
        await setEntrySeo(db.runner, admin, siteId, id, { description: "" });
        expect(await loadEntrySeo(db.runner, admin, siteId, id)).toMatchObject({
          seo: { description: "", noindex: false },
        });
        expect(await seoOf(id)).toEqual({});
      });

      test("Hide from site search: kept in meta with what is there, off again, and refused when not on or off", async () => {
        const id = await addPost("Hello");
        await db.run("update entries set meta = ? where id = ?", [
          JSON.stringify({ layout: "wide" }),
          id,
        ]);
        expect(await loadEntrySeo(db.runner, admin, siteId, id)).toMatchObject({
          seo: { hideFromSearch: false },
        });
        expect(
          await setEntrySeo(db.runner, admin, siteId, id, { hideFromSearch: true }),
        ).toMatchObject({
          ok: true,
          seo: { description: "", noindex: false, hideFromSearch: true },
        });
        const metaOf = async () => {
          const raw = (await db.run("select meta from entries where id = ?", [id]))[0]!["meta"];
          return typeof raw === "string" ? JSON.parse(raw) : raw;
        };
        expect(await metaOf()).toEqual({ layout: "wide", hideFromSearch: true });
        expect(
          await setEntrySeo(db.runner, admin, siteId, id, { hideFromSearch: "yes" }),
        ).toMatchObject({
          code: "invalid",
          field: "hideFromSearch",
        });
        await setEntrySeo(db.runner, admin, siteId, id, { hideFromSearch: false });
        expect(await metaOf()).toEqual({ layout: "wide" });
      });

      test("other things kept in the value stay, and the page counts as changed", async () => {
        const id = await addPost("Hello", {
          seo: { canonical: "https://example.org/x" },
          at: 1000,
        });
        await setEntrySeo(db.runner, admin, siteId, id, { description: "d" }, () => 9_000);
        const row = (await db.run("select seo, updated_at from entries where id = ?", [id]))[0]!;
        const seo = typeof row["seo"] === "string" ? JSON.parse(row["seo"]) : row["seo"];
        expect(seo).toEqual({ canonical: "https://example.org/x", description: "d" });
        expect(new Date(row["updated_at"] as never).getTime()).toBe(9_000);
      });

      test("refusals: a description that is too long or not text, a switch that is not on or off; nothing changes", async () => {
        const id = await addPost("Hello");
        const refuse = async (input: object, field: string) =>
          expect(
            await setEntrySeo(db.runner, admin, siteId, id, input),
            JSON.stringify(input).slice(0, 40),
          ).toMatchObject({ ok: false, code: "invalid", field });
        await refuse({ description: "x".repeat(SEO_DESCRIPTION_MAX + 1) }, "description");
        await refuse({ description: 5 }, "description");
        await refuse({ noindex: "yes" }, "noindex");
        expect(
          await setEntrySeo(db.runner, admin, siteId, id, {
            description: "x".repeat(SEO_DESCRIPTION_MAX),
          }),
        ).toMatchObject({ ok: true });
        expect(JSON.stringify(await seoOf(id))).toContain("x");
      });

      test("only people who may edit the entry; an unknown or trashed entry is not found", async () => {
        const id = await addPost("Hello");
        const stranger = actorOf(newId(), "author"); // an author may edit only their own
        expect(await setEntrySeo(db.runner, stranger, siteId, id, { noindex: true })).toMatchObject(
          { ok: false, code: "forbidden" },
        );
        expect(await loadEntrySeo(db.runner, stranger, siteId, id)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(
          await setEntrySeo(db.runner, admin, siteId, newId(), { noindex: true }),
        ).toMatchObject({ ok: false, code: "not_found" });
        const gone = await addPost("Gone", { status: "trash" });
        expect(await setEntrySeo(db.runner, admin, siteId, gone, { noindex: true })).toMatchObject({
          ok: false,
          code: "not_found",
        });
      });

      test("a page set to noindex leaves the sitemap", async () => {
        const id = await addPost("Hello");
        expect((await loadSitemapUrls(db.runner, siteId)).map((u) => u.path)).toContain(
          `/blog/${id.toLowerCase()}`,
        );
        await setEntrySeo(db.runner, admin, siteId, id, { noindex: true });
        expect((await loadSitemapUrls(db.runner, siteId)).map((u) => u.path)).not.toContain(
          `/blog/${id.toLowerCase()}`,
        );
      });
    });

    describe("the posts of a feed", () => {
      test("the newest published posts, newest first, with the author, an excerpt and the dates; not drafts, pages or noindex", async () => {
        await addPost("Old", { at: 1_000 });
        await addPost("New", { at: 3_000, text: "A new post about bread and butter." });
        await addPost("Newest", { at: 4_000, seo: { description: "Made by hand." } });
        await addPost("Draft", { status: "draft", at: 5_000 });
        await addPost("A page", { type: "page", at: 6_000 });
        await addPost("Hidden", { at: 7_000, seo: { noindex: true } });
        const feed = await loadFeedPosts(db.runner, siteId, null);
        expect(feed!.category).toBeNull();
        expect(feed!.items.map((i) => i.title)).toEqual(["Newest", "New", "Old"]);
        expect(feed!.items[0]).toMatchObject({
          authorName: "Anna",
          excerpt: "Made by hand.",
          publishedAt: 4_000,
        });
        expect(feed!.items[1]!.excerpt).toBe("A new post about bread and butter.");
        expect(feed!.items[1]!.html).toBe("<p>New body</p>");
      });

      test("at most 20, even when the newest are hidden", async () => {
        for (let n = 0; n < 25; n++) await addPost(`P${n}`, { at: 1_000 + n });
        for (let n = 0; n < 3; n++)
          await addPost(`H${n}`, { at: 9_000 + n, seo: { noindex: true } });
        const feed = await loadFeedPosts(db.runner, siteId, null);
        expect(feed!.items).toHaveLength(20);
        expect(feed!.items[0]!.title).toBe("P24");
      });

      test("a category feed holds its posts and those of the categories under it; an unknown category is null", async () => {
        const news = await category("news");
        const sport = await category("sport", news);
        const other = await category("other");
        const a = await addPost("In news", { at: 1_000 });
        const b = await addPost("In sport", { at: 2_000 });
        const c = await addPost("Elsewhere", { at: 3_000 });
        await link(a, news);
        await link(b, sport);
        await link(c, other);
        const feed = await loadFeedPosts(db.runner, siteId, "news");
        expect(feed!.category).toEqual({ name: "NEWS", slug: "news" });
        expect(feed!.items.map((i) => i.title)).toEqual(["In sport", "In news"]);
        expect(
          (await loadFeedPosts(db.runner, siteId, "sport"))!.items.map((i) => i.title),
        ).toEqual(["In sport"]);
        expect(await loadFeedPosts(db.runner, siteId, "nope")).toBeNull();
        // A post in two categories of the same tree appears once.
        await link(a, sport);
        expect(
          (await loadFeedPosts(db.runner, siteId, "news"))!.items.filter(
            (i) => i.title === "In news",
          ),
        ).toHaveLength(1);
      });
    });
  });
}
