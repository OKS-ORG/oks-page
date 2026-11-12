import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, saveContent, type Actor } from "./content.js";
import {
  REDIRECT_PATH_MAX,
  addRedirect,
  cleanPath,
  countRedirectHit,
  deleteRedirect,
  findRedirect,
  listRedirects,
  pathOfSlug,
  recordSlugChange,
} from "./redirects.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("paths", () => {
  test("the front page is /, other slugs get a slash, trailing slashes go", () => {
    expect(pathOfSlug("home")).toBe("/");
    expect(pathOfSlug("blog/hello")).toBe("/blog/hello");
    expect(cleanPath("/about/")).toBe("/about");
    expect(cleanPath("/about///")).toBe("/about");
    expect(cleanPath(" / ")).toBe("/");
    expect(cleanPath("/")).toBe("/");
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: redirects`, () => {
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
          siteName: "S",
          starterContent: true,
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      admin = actorOf(setup.userId, "administrator");
      editor = actorOf(setup.userId, "editor");
    });
    afterEach(async () => {
      await db.close();
    });

    const rows = async () =>
      (await listRedirects(db.runner, siteId))
        .map((r) => `${r.from} -> ${r.to} (${r.status})`)
        .sort();

    describe("when a published address changes (SEO-25, SEO-53)", () => {
      test("old → new is added as a 301, and nothing else", async () => {
        await recordSlugChange(db.runner, siteId, "blog/a", "blog/b");
        expect(await rows()).toEqual(["/blog/a -> /blog/b (301)"]);
        // Repeating it changes nothing.
        await recordSlugChange(db.runner, siteId, "blog/a", "blog/b");
        expect(await rows()).toEqual(["/blog/a -> /blog/b (301)"]);
      });

      test("a chain is always one step: a→b then b→c gives a→c and b→c", async () => {
        await recordSlugChange(db.runner, siteId, "a", "b");
        await recordSlugChange(db.runner, siteId, "b", "c");
        expect(await rows()).toEqual(["/a -> /c (301)", "/b -> /c (301)"]);
      });

      test("after 200 renames in a row every old address is one step from the live one", async () => {
        for (let n = 0; n < 200; n++)
          await recordSlugChange(db.runner, siteId, `p${n}`, `p${n + 1}`);
        const all = await listRedirects(db.runner, siteId);
        expect(all).toHaveLength(200);
        expect(new Set(all.map((r) => r.to))).toEqual(new Set(["/p200"]));
      });

      test("going back to an old address removes the redirect from it, so there is no loop", async () => {
        await recordSlugChange(db.runner, siteId, "a", "b");
        await recordSlugChange(db.runner, siteId, "b", "a");
        expect(await rows()).toEqual(["/b -> /a (301)"]);
      });

      test("the front page address is never redirected away, but a page can take the front page", async () => {
        await recordSlugChange(db.runner, siteId, "home", "start");
        expect(await rows()).toEqual([]);
        await recordSlugChange(db.runner, siteId, "start", "home");
        expect(await rows()).toEqual(["/start -> / (301)"]);
        await recordSlugChange(db.runner, siteId, "x", "x");
        expect(await rows()).toEqual(["/start -> / (301)"]);
      });

      test("saving a published page with a new address adds the redirect; a draft, a scheduled or an unchanged address does not", async () => {
        const made = await createDraft(db.runner, admin, siteId, { type: "post", title: "First" });
        if (!made.ok) throw new Error("setup");
        const save = (slugPart: string, status: string, revision: number) =>
          saveContent(db.runner, admin, siteId, made.id, {
            title: "First",
            slugPart,
            status,
            blocks: [],
            revision,
          });
        // A draft never had a public address: no redirect when it changes.
        const draft = await save("one", "draft", made.revision);
        if (!draft.ok) throw new Error(draft.message);
        expect(await rows()).toEqual([]);
        const published = await save("one", "published", draft.revision);
        if (!published.ok) throw new Error(published.message);
        expect(await rows()).toEqual([]);
        // Published → published with a new address: the old one is redirected.
        const moved = await save("two", "published", published.revision);
        if (!moved.ok) throw new Error(moved.message);
        expect(await rows()).toEqual(["/blog/one -> /blog/two (301)"]);
        // Unchanged address: nothing new.
        const same = await save("two", "published", moved.revision);
        if (!same.ok) throw new Error(same.message);
        expect(await rows()).toEqual(["/blog/one -> /blog/two (301)"]);
        // Published → draft with a new address: the old address is gone for good (404), no redirect to a hidden page.
        const hidden = await save("three", "draft", same.revision);
        if (!hidden.ok) throw new Error(hidden.message);
        expect(await rows()).toEqual(["/blog/one -> /blog/two (301)"]);
      });
    });

    describe("by hand", () => {
      test("add, list and delete; the owner only", async () => {
        const added = await addRedirect(db.runner, admin, siteId, { from: "/old/", to: "/about" });
        expect(added).toMatchObject({ ok: true, from: "/old", to: "/about" });
        const list = await listRedirects(db.runner, siteId);
        expect(list).toMatchObject([{ from: "/old", to: "/about", status: 301, hits: 0 }]);
        expect(
          await addRedirect(db.runner, editor, siteId, { from: "/x", to: "/y" }),
        ).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await deleteRedirect(db.runner, editor, siteId, list[0]!.id)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await deleteRedirect(db.runner, admin, siteId, list[0]!.id)).toMatchObject({
          ok: true,
        });
        expect(await deleteRedirect(db.runner, admin, siteId, list[0]!.id)).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(await listRedirects(db.runner, siteId)).toEqual([]);
      });

      test("changing an existing one keeps its count; an outside address and other kinds are allowed", async () => {
        await addRedirect(db.runner, admin, siteId, { from: "/old", to: "/a" });
        const [first] = await listRedirects(db.runner, siteId);
        await countRedirectHit(db.runner, first!.id);
        await countRedirectHit(db.runner, first!.id);
        await addRedirect(db.runner, admin, siteId, {
          from: "/old",
          to: "https://example.org/new",
          status: 302,
        });
        expect(await listRedirects(db.runner, siteId)).toMatchObject([
          { from: "/old", to: "https://example.org/new", status: 302, hits: 2 },
        ]);
      });

      test("refusals: itself, a loop, the front page, system paths, a live page, bad shapes and kinds", async () => {
        const bad = (from: string, to: string, status?: number) =>
          addRedirect(db.runner, admin, siteId, { from, to, ...(status ? { status } : {}) });
        expect(await bad("/a", "/a")).toMatchObject({
          ok: false,
          message: "A redirect cannot point to itself.",
        });
        expect(await bad("/a/", "/a")).toMatchObject({ ok: false });
        await bad("/a", "/b");
        expect(await bad("/b", "/a")).toMatchObject({
          ok: false,
          message: "This would make a loop.",
        });
        await bad("/c", "/a"); // a→b, c→a becomes c→b: fine
        expect(await rows()).toEqual(["/a -> /b (301)", "/c -> /b (301)"]);
        // A longer loop: b→x, x→c would close the circle c→a→b→x→c.
        await bad("/b", "/x").then((r) => expect(r.ok).toBe(true));
        expect(await bad("/x", "/c")).toMatchObject({
          ok: false,
          message: "This would make a loop.",
        });
        expect(await bad("/", "/a")).toMatchObject({ ok: false });
        for (const path of ["/admin", "/admin/x", "/api/x", "/_next/x", "/search", "/sitemap.xml"])
          expect(await bad(path, "/a"), path).toMatchObject({ ok: false });
        expect(await bad("/about", "/a")).toMatchObject({ ok: false }); // a published page uses it
        expect(await bad("no-slash", "/a")).toMatchObject({ ok: false });
        expect(await bad("/with space", "/a")).toMatchObject({ ok: false });
        expect(await bad("/q?x=1", "/a")).toMatchObject({ ok: false });
        expect(await bad("/ok", "//evil.example.com")).toMatchObject({ ok: false });
        expect(await bad("/ok", "javascript:alert(1)")).toMatchObject({ ok: false });
        expect(await bad("/ok", "/a b")).toMatchObject({ ok: false });
        expect(await bad("/ok2", "/a", 303)).toMatchObject({ ok: false });
        expect(await bad("/" + "x".repeat(REDIRECT_PATH_MAX), "/a")).toMatchObject({ ok: false });
      });

      test("adding a redirect whose target already redirects goes straight to the end", async () => {
        await addRedirect(db.runner, admin, siteId, { from: "/b", to: "/c" });
        await addRedirect(db.runner, admin, siteId, { from: "/a", to: "/b" });
        expect(await rows()).toEqual(["/a -> /c (301)", "/b -> /c (301)"]);
      });
    });

    describe("what the proxy asks", () => {
      test("an address that is redirected is found, with its kind; others are not", async () => {
        await addRedirect(db.runner, admin, siteId, { from: "/old", to: "/new", status: 302 });
        expect(await findRedirect(db.runner, siteId, "/old")).toMatchObject({
          to: "/new",
          status: 302,
        });
        expect(await findRedirect(db.runner, siteId, "/other")).toBeNull();
        expect(await findRedirect(db.runner, newId(), "/old")).toBeNull();
      });
    });
  });
}
