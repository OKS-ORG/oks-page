// What needs consent on the site (spec 18, section 2; PR-02): the cookies and outside addresses of switched-on plugins and
// videos set to "load at once" in published pages, and nothing else. In SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { loadConsentNeeds } from "./consent-needs";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000153";
const OTHER = "SITE0000000000000000000154";
const USER = "USER0000000000000000000153";

const cookie = (purpose: string) => ({ name: "demo_visit", purpose, why: "Counts visits." });
const host = (purpose: string) => ({ host: "maps.example.com", purpose, why: "Shows a map." });

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: what needs consent`, () => {
    let db: TestDb;
    let n = 0;

    const plugin = async (key: string, manifest: unknown, status = "enabled", site = SITE) => {
      n += 1;
      await db.run(
        "insert into extensions (id, site_id, key, kind, version, tier, status, manifest, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?, ?, ?)",
        [`EXT${String(n).padStart(23, "0")}`, site, key, status, JSON.stringify(manifest), T],
      );
    };
    const entry = async (title: string, body: unknown, status = "published", site = SITE) => {
      n += 1;
      await db.run(
        `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, seo, meta, created_at, updated_at)
         values (?, ?, 'page', ?, ?, ?, ?, '{}', ?, '{}', '{}', ?, ?)`,
        [
          `ENT${String(n).padStart(23, "0")}`,
          site,
          status,
          title,
          `p${n}`,
          USER,
          JSON.stringify(body),
          T,
          T,
        ],
      );
    };
    const video = (loadNow: boolean) => [
      {
        id: "b1",
        type: "video",
        props: { src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", loadNow },
      },
    ];

    beforeEach(async () => {
      db = await open();
      n = 0;
      for (const id of [SITE, OTHER])
        await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
          id,
          T,
          T,
        ]);
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, 'Anna', 'anna@garden.example', ?, ?)",
        [USER, T, T],
      );
    });

    test("a new site needs no consent", async () => {
      expect(await loadConsentNeeds(db.runner, SITE)).toEqual({
        plugins: [],
        videos: [],
        needed: false,
      });
    });

    test("a plugin that declares a cookie or an outside address needs it, and one that only declares essential things does not", async () => {
      await plugin("stats", { cookies: [cookie("statistics")] });
      let r = await loadConsentNeeds(db.runner, SITE);
      expect(r.needed).toBe(true);
      expect(r.plugins).toMatchObject([{ plugin: "stats", cookies: [{ name: "demo_visit" }] }]);
      await db.run(`delete from extensions`);
      await plugin("login", { cookies: [cookie("essential")], outsideHosts: [host("essential")] });
      r = await loadConsentNeeds(db.runner, SITE);
      expect(r.needed).toBe(false);
      expect(r.plugins.length).toBe(1);
      await plugin("maps", { outsideHosts: [host("media")] });
      expect((await loadConsentNeeds(db.runner, SITE)).needed).toBe(true);
    });

    test("a plugin that is switched off, another site's plugin and a broken declaration are ignored", async () => {
      await plugin("off", { cookies: [cookie("marketing")] }, "switched_off");
      await plugin("elsewhere", { cookies: [cookie("marketing")] }, "enabled", OTHER);
      await plugin("broken", { cookies: [{ name: "a b", purpose: "marketing", why: "x" }] });
      await plugin("none", { personalData: [] });
      expect(await loadConsentNeeds(db.runner, SITE)).toEqual({
        plugins: [],
        videos: [],
        needed: false,
      });
    });

    test("a video set to load at once in a published page needs consent; a click-to-load video, a draft and another site do not", async () => {
      await entry("Our film", video(true));
      await entry("Click first", video(false));
      await entry("Draft film", video(true), "draft");
      await entry("Elsewhere", video(true), "published", OTHER);
      const r = await loadConsentNeeds(db.runner, SITE);
      expect(r.needed).toBe(true);
      expect(r.videos).toMatchObject([{ title: "Our film", company: "youtube.com" }]);
    });

    test("a video inside another block is found too", async () => {
      await entry("Nested", [
        {
          id: "c",
          type: "columns",
          children: [[{ type: "video", props: { src: "https://vimeo.com/1", loadNow: true } }]],
        },
      ]);
      expect((await loadConsentNeeds(db.runner, SITE)).videos).toMatchObject([
        { title: "Nested", company: "vimeo.com" },
      ]);
    });
  });
}
