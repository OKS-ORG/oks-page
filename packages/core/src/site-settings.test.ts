import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, type Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import {
  DEFAULT_WRITING,
  listCategoryChoices,
  loadSiteIcon,
  loadWritingSettings,
  readWritingSettings,
  saveSiteIcon,
  saveWritingSettings,
} from "./site-settings.js";
import { createTerm } from "./taxonomies.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("writing values", () => {
  test("odd stored values fall back to the defaults", () => {
    expect(readWritingSettings(null)).toEqual(DEFAULT_WRITING);
    expect(readWritingSettings({ defaultCategoryId: "x", defaultLayout: "../evil" })).toEqual(
      DEFAULT_WRITING,
    );
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the site icon and the writing defaults`, () => {
    let db: TestDb;
    let siteId = "";
    let userId = "";
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
      userId = setup.userId;
      admin = actorOf(userId, "administrator");
      editor = actorOf(userId, "editor");
    });
    afterEach(async () => db.close());

    const picture = async (mime: string, width: number, height: number, status = "ready") => {
      const id = newId();
      await db.run(
        `insert into media (id, site_id, storage_key, filename, mime_type, size_bytes, width, height, content_hash, status, uploaded_by, created_at)
          values (?, ?, ?, 'x', ?, 10, ?, ?, 'h', ?, ?, ?)`,
        [id, siteId, `2026/11/${id}-x`, mime, width, height, status, userId, T],
      );
      return id;
    };

    test("the site icon: a square picture of at least 512 × 512 from the library; it can be removed", async () => {
      expect(await loadSiteIcon(db.runner, siteId)).toBeNull();
      const good = await picture("image/png", 512, 512);
      expect(await saveSiteIcon(db.runner, editor, siteId, good)).toMatchObject({
        code: "forbidden",
      });
      for (const bad of [
        await picture("image/png", 512, 300),
        await picture("image/png", 256, 256),
        await picture("image/svg+xml", 600, 600),
        await picture("application/pdf", 600, 600),
        await picture("image/png", 600, 600, "processing"),
        newId(),
      ])
        expect(await saveSiteIcon(db.runner, admin, siteId, bad)).toMatchObject({
          ok: false,
          field: "siteIcon",
        });
      expect(await saveSiteIcon(db.runner, admin, siteId, good)).toMatchObject({
        ok: true,
        icon: { mediaId: good, mime: "image/png", width: 512 },
      });
      expect(await loadSiteIcon(db.runner, siteId)).toMatchObject({ mediaId: good });
      // A picture that is deleted later simply stops being the icon.
      await db.run("delete from media where id = ?", [good]);
      expect(await loadSiteIcon(db.runner, siteId)).toBeNull();
      expect(await saveSiteIcon(db.runner, admin, siteId, null)).toEqual({ ok: true, icon: null });
    });

    test("writing: a new post starts in the default category; a page does not; the choices are checked", async () => {
      const news = await createTerm(db.runner, admin, siteId, "category", { name: "News" });
      if (!news.ok) throw new Error(news.message);
      const categories = await listCategoryChoices(db.runner, siteId);
      const newsId = categories.find((c) => c.name === "News")!.id;
      expect(
        await saveWritingSettings(db.runner, editor, siteId, { defaultCategoryId: newsId }),
      ).toMatchObject({
        code: "forbidden",
      });
      expect(
        await saveWritingSettings(db.runner, admin, siteId, { defaultCategoryId: newId() }),
      ).toMatchObject({ ok: false, field: "defaultCategoryId" });
      expect(
        await saveWritingSettings(db.runner, admin, siteId, { defaultLayout: "custom-nothing" }),
      ).toMatchObject({ ok: false, field: "defaultLayout" });
      expect(
        await saveWritingSettings(db.runner, admin, siteId, { defaultCategoryId: newsId }),
      ).toEqual({
        ok: true,
        settings: { defaultCategoryId: newsId, defaultLayout: "" },
      });
      expect(await loadWritingSettings(db.runner, siteId)).toEqual({
        defaultCategoryId: newsId,
        defaultLayout: "",
      });

      const post = await createDraft(db.runner, admin, siteId, { type: "post", title: "Spring" });
      const page = await createDraft(db.runner, admin, siteId, {
        type: "page",
        title: "Opening hours",
      });
      if (!post.ok || !page.ok) throw new Error("not made");
      const termsOf = async (id: string) =>
        (await db.run("select term_id from entry_terms where entry_id = ?", [id])).map(
          (r) => r["term_id"],
        );
      expect(await termsOf(post.id)).toEqual([newsId]);
      expect(await termsOf(page.id)).toEqual([]);
      // A category that is deleted later is simply not used.
      await db.run("delete from terms where id = ?", [newsId]);
      const later = await createDraft(db.runner, admin, siteId, { type: "post", title: "Summer" });
      if (!later.ok) throw new Error("not made");
      expect(await termsOf(later.id)).toEqual([]);
    });
  });
}
