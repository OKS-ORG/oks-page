// Settings > Screen sizes (spec 06, 4.1; PB-100): which sizes the site designs for, and what that changes: the
// styles a saved page keeps, and the CSS a published page is given. On SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, loadForEdit, saveContent, type Actor } from "./content.js";
import { loadPageCss } from "./page-css.js";
import { DEFAULT_ROLES } from "./roles.js";
import { loadScreenSizes, readScreenSizes, saveScreenSizes } from "./screen-sizes.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("reading the stored list", () => {
  test("anything odd is the default; the phone size is always on; the order is smallest first", () => {
    expect(readScreenSizes(undefined)).toEqual(["base", "tablet", "desktop"]);
    expect(readScreenSizes("x")).toEqual(["base", "tablet", "desktop"]);
    expect(readScreenSizes({ sizes: ["desktop", "laptop"] })).toEqual([
      "base",
      "laptop",
      "desktop",
    ]);
    expect(readScreenSizes({ sizes: ["nonsense", 4] })).toEqual(["base"]);
    expect(readScreenSizes([])).toEqual(["base"]);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: screen sizes`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let eve: Actor;

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
      const eveId = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [eveId, "Eve", "eve@example.com", T, T],
      );
      eve = actorOf(eveId, "editor");
    });
    afterEach(async () => db.close());

    test("a new site designs for phone, tablet and desktop", async () => {
      expect(await loadScreenSizes(db.runner, siteId)).toEqual(["base", "tablet", "desktop"]);
    });

    test("only people who manage the settings may change them; unknown sizes are refused", async () => {
      const denied = await saveScreenSizes(db.runner, eve, siteId, { sizes: ["base", "laptop"] });
      expect(denied).toMatchObject({ ok: false, code: "forbidden" });
      const bad = await saveScreenSizes(db.runner, anna, siteId, { sizes: ["base", "huge"] });
      expect(bad).toMatchObject({ ok: false, code: "invalid" });
      const none = await saveScreenSizes(db.runner, anna, siteId, {});
      expect(none).toMatchObject({ ok: false, code: "invalid" });
      expect(await loadScreenSizes(db.runner, siteId)).toEqual(["base", "tablet", "desktop"]);
    });

    test("a saved choice is kept in order, with the phone size always on", async () => {
      const saved = await saveScreenSizes(db.runner, anna, siteId, {
        sizes: ["desktop", "laptop"],
      });
      expect(saved).toEqual({ ok: true, sizes: ["base", "laptop", "desktop"] });
      expect(await loadScreenSizes(db.runner, siteId)).toEqual(["base", "laptop", "desktop"]);
      // Saving again replaces it (a second row would break the key).
      await saveScreenSizes(db.runner, anna, siteId, { sizes: ["base"] });
      expect(await loadScreenSizes(db.runner, siteId)).toEqual(["base"]);
    });

    test("a page keeps a style for a size that is on, and loses it on save when the size is off; the published CSS follows the list", async () => {
      const block = (style: unknown) => ({
        id: "styled0001",
        type: "section",
        props: { style },
        content: null,
        children: [],
      });
      const style = { base: { padding: "8px" }, laptop: { padding: "40px" } };
      const made = await createDraft(db.runner, anna, siteId, { type: "page", title: "P" });
      if (!made.ok) throw new Error(made.message);
      const body = (revision: number, status: "draft" | "published") => ({
        title: "P",
        slugPart: made.slug,
        status,
        blocks: [block(style)],
        revision,
      });
      // Laptop is off: the style for it is removed when the page is saved.
      let saved = await saveContent(db.runner, anna, siteId, made.id, body(made.revision, "draft"));
      if (!saved.ok) throw new Error(saved.message);
      let loaded = await loadForEdit(db.runner, anna, siteId, made.id);
      if (!loaded.ok) throw new Error(loaded.message);
      const styleOf = () =>
        (loaded.ok
          ? (loaded.entry.blocks as { props: { style?: Record<string, unknown> } }[])
          : [])[0]!.props.style;
      expect(styleOf()).toEqual({ base: { padding: "8px" } });

      // Laptop is on: it is kept, and the published CSS has its media query.
      await saveScreenSizes(db.runner, anna, siteId, { sizes: ["base", "laptop"] });
      saved = await saveContent(
        db.runner,
        anna,
        siteId,
        made.id,
        body(saved.revision, "published"),
      );
      if (!saved.ok) throw new Error(saved.message);
      loaded = await loadForEdit(db.runner, anna, siteId, made.id);
      expect(styleOf()).toEqual(style);
      const css = await loadPageCss(db.runner, siteId, made.id);
      expect(css).toContain("@media (min-width:768px){");
      expect(css).toContain("padding:40px");
      // base to 767, laptop from 768: tablet and desktop are not on, so there is no 881 or 1367 rule.
      expect(css).not.toContain("min-width:881px");

      // Switched off again: the stored style stays until the page is saved, but the CSS no longer draws it.
      await saveScreenSizes(db.runner, anna, siteId, { sizes: ["base"] });
      const after = await loadPageCss(db.runner, siteId, made.id);
      expect(after).not.toContain("padding:40px");
      expect(after).toContain("padding:8px");
    });
  });
}
