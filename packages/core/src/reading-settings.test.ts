import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  DEFAULT_READING,
  directionOf,
  listPageChoices,
  loadReadingRoutes,
  loadReadingSettings,
  loadSiteLanguage,
  readReadingSettings,
  readSiteLanguage,
  saveReadingSettings,
  saveSiteLanguage,
} from "./reading-settings.js";
import { DEFAULT_ROLES } from "./roles.js";
import { buildAtom, buildRss } from "./seo-meta.js";
import { runSetup } from "./setup.js";
import { layoutCandidates } from "./theme-layouts.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("reading and language values", () => {
  test("odd stored values fall back to the defaults", () => {
    expect(readReadingSettings(null)).toEqual(DEFAULT_READING);
    expect(
      readReadingSettings({
        homeShows: "posts",
        perPage: 500,
        homePageId: "x",
        feedFullText: false,
      }),
    ).toEqual({ ...DEFAULT_READING, homeShows: "posts", feedFullText: false });
    expect(readSiteLanguage({ tag: "<script>", direction: "sideways" })).toEqual({
      tag: "en",
      direction: "auto",
    });
  });

  test("the writing direction follows the language unless chosen", () => {
    expect(directionOf({ tag: "ar", direction: "auto" })).toBe("rtl");
    expect(directionOf({ tag: "ur", direction: "auto" })).toBe("rtl");
    expect(directionOf({ tag: "he-IL", direction: "auto" })).toBe("rtl");
    expect(directionOf({ tag: "en-GB", direction: "auto" })).toBe("ltr");
    expect(directionOf({ tag: "ar", direction: "ltr" })).toBe("ltr");
    expect(directionOf({ tag: "de", direction: "rtl" })).toBe("rtl");
  });

  test("the list of newest posts uses a theme's home layout, then index", () => {
    expect(layoutCandidates({ kind: "posts" })).toEqual(["home", "index"]);
  });

  test("a feed carries the full text, or only a summary", () => {
    const info = {
      origin: "https://garden.example",
      siteName: "S",
      description: "",
      homePath: "/",
      selfPath: "/feed.xml",
      title: "S",
    };
    const items = [
      {
        title: "Hi",
        path: "/blog/hi",
        html: "<p>The whole text</p>",
        excerpt: "A summary",
        publishedAt: 1,
        modifiedAt: 1,
        authorName: "",
      },
    ];
    expect(buildRss(info, items)).toContain("content:encoded");
    expect(buildRss({ ...info, fullText: false }, items)).not.toContain("content:encoded");
    expect(buildRss({ ...info, fullText: false }, items)).toContain(
      "<description>A summary</description>",
    );
    expect(buildAtom({ ...info, fullText: false }, items)).not.toContain('<content type="html">');
    expect(buildAtom({ ...info, fullText: false }, items)).toContain(
      "<summary>A summary</summary>",
    );
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: Settings > Reading and Languages`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;

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
          siteName: "Anna's Garden",
          starterContent: true,
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      admin = actorOf(setup.userId, "administrator");
      editor = actorOf(setup.userId, "editor");
    });
    afterEach(async () => db.close());

    const pageId = async (slug: string) =>
      String((await db.run("select id from entries where slug = ?", [slug]))[0]!["id"]);

    test("the defaults, the published pages to choose from, and the addresses they lead to", async () => {
      expect(await loadReadingSettings(db.runner, siteId)).toEqual(DEFAULT_READING);
      expect((await listPageChoices(db.runner, siteId)).map((p) => p.slug).sort()).toEqual([
        "about",
        "contact",
        "home",
      ]);
      expect(await loadReadingRoutes(db.runner, siteId)).toEqual({
        homeShows: "page",
        homeSlug: "home",
        postsSlug: null,
        postsTitle: "",
        perPage: 10,
      });
      await saveReadingSettings(db.runner, admin, siteId, {
        homePageId: await pageId("contact"),
        postsPageId: await pageId("about"),
        perPage: 3,
      });
      expect(await loadReadingRoutes(db.runner, siteId)).toEqual({
        homeShows: "page",
        homeSlug: "contact",
        postsSlug: "about",
        postsTitle: "About",
        perPage: 3,
      });
      // A chosen page that is no longer published is left out.
      await db.run("update entries set status = 'draft' where slug = 'about'");
      expect((await loadReadingRoutes(db.runner, siteId)).postsSlug).toBeNull();
    });

    test("the checks: who may, the numbers, the pages, and home and posts page not the same", async () => {
      expect(await saveReadingSettings(db.runner, editor, siteId, { perPage: 5 })).toMatchObject({
        code: "forbidden",
      });
      for (const [input, field] of [
        [{ perPage: 0 }, "perPage"],
        [{ perPage: 51 }, "perPage"],
        [{ homeShows: "everything" }, "homeShows"],
        [{ feedFullText: "yes" }, "feedFullText"],
        [{ homePageId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }, "homePageId"],
      ] as const)
        expect(await saveReadingSettings(db.runner, admin, siteId, input)).toMatchObject({
          ok: false,
          field,
        });
      // A post is not a page.
      expect(
        await saveReadingSettings(db.runner, admin, siteId, {
          postsPageId: await pageId("blog/hello-world"),
        }),
      ).toMatchObject({ ok: false, field: "postsPageId" });
      const about = await pageId("about");
      expect(
        await saveReadingSettings(db.runner, admin, siteId, {
          homePageId: about,
          postsPageId: about,
        }),
      ).toMatchObject({
        ok: false,
        message: "The home page and the posts page must be different pages.",
      });
      expect(
        await saveReadingSettings(db.runner, admin, siteId, {
          homeShows: "posts",
          feedFullText: false,
        }),
      ).toMatchObject({
        ok: true,
        settings: { homeShows: "posts", feedFullText: false, perPage: 10 },
      });
    });

    test("the site language: saved, checked, and only by people who manage the settings", async () => {
      expect(await loadSiteLanguage(db.runner, siteId)).toEqual({ tag: "en", direction: "auto" });
      expect(await saveSiteLanguage(db.runner, editor, siteId, { tag: "ar" })).toMatchObject({
        code: "forbidden",
      });
      expect(await saveSiteLanguage(db.runner, admin, siteId, { tag: "not a tag" })).toMatchObject({
        field: "tag",
      });
      expect(await saveSiteLanguage(db.runner, admin, siteId, { direction: "up" })).toMatchObject({
        field: "direction",
      });
      expect(await saveSiteLanguage(db.runner, admin, siteId, { tag: "ar" })).toEqual({
        ok: true,
        language: { tag: "ar", direction: "auto" },
      });
      expect(await loadSiteLanguage(db.runner, siteId)).toEqual({ tag: "ar", direction: "auto" });
    });
  });
}
