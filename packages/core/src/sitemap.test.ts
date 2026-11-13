import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import {
  DEFAULT_SEO_SETTINGS,
  loadSeoSettings,
  readSeoSettings,
  saveSeoSettings,
} from "./seo-settings.js";
import { runSetup } from "./setup.js";
import { buildRobotsTxt, buildSitemapXml, loadSitemapUrls } from "./sitemap.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("the sitemap file (SEO-30 to SEO-32)", () => {
  test("it is well-formed, addresses are absolute and percent-encoded, and & < > quotes are escaped", () => {
    const xml = buildSitemapXml("https://example.com", [
      { path: "/", lastModified: 0 },
      { path: "/blog/नमस्ते", lastModified: 1_700_000_000_000 },
      { path: "/a&b/<c>/\"d\"/'e'", lastModified: 5 },
    ]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns=')).toBe(true);
    expect(xml).toContain(
      "<loc>https://example.com/</loc><lastmod>1970-01-01T00:00:00.000Z</lastmod>",
    );
    expect(xml).toContain(
      "<loc>https://example.com/blog/%E0%A4%A8%E0%A4%AE%E0%A4%B8%E0%A5%8D%E0%A4%A4%E0%A5%87</loc>",
    );
    expect(xml).toContain("2023-11-14T22:13:20.000Z");
    // The address is percent-encoded by the URL rules, and nothing in a <loc> can break the XML.
    const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]!);
    for (const loc of locs) expect(loc).not.toMatch(/[<>"']/);
    // Every & that is left starts one of the five XML entities.
    expect(xml.replace(/&(amp|lt|gt|quot|apos);/g, "").includes("&")).toBe(false);
  });
  test("an empty site gives an empty list, still valid", () => {
    expect(buildSitemapXml("https://example.com", [])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n',
    );
  });
});

describe("robots.txt (SEO-10)", () => {
  test("normally: the admin, the API and the search page are closed, the sitemap is listed, and nothing else is blocked", () => {
    const txt = buildRobotsTxt("https://example.com", false);
    expect(txt).toBe(
      "User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /search\n\nSitemap: https://example.com/sitemap.xml\n",
    );
    // Never blocks CSS, scripts or images.
    expect(txt).not.toMatch(/_next|uploads|\.css|\.js/);
  });
  test("when search engines are asked to stay away: everything is closed and no sitemap is listed", () => {
    expect(buildRobotsTxt("https://example.com", true)).toBe("User-agent: *\nDisallow: /\n");
  });
});

describe("reading the setting", () => {
  test("only an explicit true means on; damaged values mean open", () => {
    expect(readSeoSettings({ discourageIndexing: true })).toEqual({ discourageIndexing: true });
    expect(readSeoSettings(JSON.stringify({ discourageIndexing: true }))).toEqual({
      discourageIndexing: true,
    });
    for (const bad of [
      undefined,
      null,
      "x",
      5,
      [],
      { discourageIndexing: "yes" },
      { discourageIndexing: 1 },
    ])
      expect(readSeoSettings(bad)).toEqual(DEFAULT_SEO_SETTINGS);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: what the sitemap lists and the setting`, () => {
    let db: TestDb;
    let siteId = "";
    let userId = "";
    let admin: Actor;
    let editor: Actor;

    const add = async (
      slug: string,
      opts: { status?: string; type?: string; seo?: object; at?: number } = {},
    ) => {
      const id = newId();
      await db.run(
        `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, published_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, '{}', '{"version":1,"blocks":[]}', '', '', ?, '{}', ?, ?, ?)`,
        [
          id,
          siteId,
          opts.type ?? "post",
          opts.status ?? "published",
          slug,
          slug,
          userId,
          JSON.stringify(opts.seo ?? {}),
          new Date(opts.at ?? 5_000),
          T,
          new Date(opts.at ?? 5_000),
        ],
      );
      return id;
    };
    const term = async (taxonomy: string, slug: string, parent: string | null = null) => {
      const id = newId();
      const tax = String(
        (await db.run("select id from taxonomies where key = ?", [taxonomy]))[0]!["id"],
      );
      await db.run(
        "insert into terms (id, taxonomy_id, parent_id, slug, name, description) values (?, ?, ?, ?, ?, '')",
        [id, tax, parent, slug, slug],
      );
      return id;
    };
    const link = (entry: string, termId: string) =>
      db.run("insert into entry_terms (entry_id, term_id, position) values (?, ?, 0)", [
        entry,
        termId,
      ]);

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
      admin = actorOf(setup.userId, "administrator");
      editor = actorOf(setup.userId, "editor");
    });
    afterEach(async () => {
      await db.close();
    });

    test("published entries only: not drafts, private, scheduled, trashed or noindex; the front page is /", async () => {
      await add("home", { type: "page", at: 9_000 });
      await add("about", { type: "page" });
      await add("blog/ok");
      await add("blog/draft", { status: "draft" });
      await add("blog/private", { status: "private" });
      await add("blog/scheduled", { status: "scheduled" });
      await add("blog/trash", { status: "trash" });
      await add("blog/noindex", { seo: { noindex: true } });
      const urls = await loadSitemapUrls(db.runner, siteId);
      expect(urls.map((u) => u.path)).toEqual(["/", "/about", "/blog/ok"]);
      expect(urls[0]!.lastModified).toBe(9_000);
    });

    test("category and tag pages are listed when they hold a published post, and the categories above them too", async () => {
      const news = await term("category", "news");
      const sport = await term("category", "sport", news);
      const garden = await term("tag", "garden");
      const empty = await term("tag", "empty");
      const draftOnly = await term("tag", "draft-only");
      const post = await add("blog/a", { at: 7_000 });
      const hidden = await add("blog/h", { seo: { noindex: true } });
      const draft = await add("blog/d", { status: "draft" });
      await link(post, sport);
      await link(post, garden);
      await link(hidden, empty);
      await link(draft, draftOnly);
      const urls = await loadSitemapUrls(db.runner, siteId);
      expect(urls.map((u) => u.path)).toEqual([
        "/blog/a",
        "/category/news",
        "/category/sport",
        "/tag/garden",
      ]);
      // The page of a category changes when its newest post does.
      expect(urls.find((u) => u.path === "/category/sport")!.lastModified).toBe(7_000);
      expect(urls.find((u) => u.path === "/category/news")!.lastModified).toBe(7_000);
    });

    test("the search-engines setting: off at first, saved in one row, the owner only", async () => {
      expect(await loadSeoSettings(db.runner, siteId)).toEqual({ discourageIndexing: false });
      expect(
        await saveSeoSettings(db.runner, editor, siteId, { discourageIndexing: true }),
      ).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(
        await saveSeoSettings(db.runner, admin, siteId, { discourageIndexing: "yes" as never }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect(await db.run("select 1 from settings where key = 'seo'")).toHaveLength(0);
      expect(
        await saveSeoSettings(db.runner, admin, siteId, { discourageIndexing: true }),
      ).toMatchObject({
        ok: true,
        settings: { discourageIndexing: true },
      });
      await saveSeoSettings(db.runner, admin, siteId, {});
      expect(await loadSeoSettings(db.runner, siteId)).toEqual({ discourageIndexing: true });
      await saveSeoSettings(db.runner, admin, siteId, { discourageIndexing: false });
      const rows = await db.run("select revision from settings where key = 'seo'");
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!["revision"])).toBe(3);
    });
  });
}
