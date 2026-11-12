// Autosave and the "someone else is editing" notice on SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, loadForEdit, saveContent, type Actor } from "./content.js";
import {
  LOCK_SECONDS,
  discardAutosave,
  loadAutosave,
  saveAutosave,
  stopEditing,
  touchEditing,
} from "./editing.js";
import { listRevisions } from "./revisions.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = 1_700_000_000_000;
const para = (value: string) => ({
  id: newId(),
  type: "paragraph",
  props: {},
  content: [{ type: "text", text: value, styles: {} }],
  children: [],
});

const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: autosave and the editing notice`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let bob: Actor;
    let cara: Actor;
    let pageId = "";

    const user = async (name: string) => {
      const id = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [id, name, `${name.toLowerCase()}@example.com`, new Date(T), new Date(T)],
      );
      return id;
    };
    const save = (actor: Actor, revision: number, text: string) =>
      saveContent(
        db.runner,
        actor,
        siteId,
        pageId,
        { title: "Page", slugPart: "page", status: "draft", blocks: [para(text)], revision },
        () => T,
      );
    const autosaves = async () =>
      db.runner.all(`select "author_id" from "entry_revisions" where "kind" = 'autosave'`);

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const userId = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [userId, name, email, new Date(T), new Date(T)],
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
      bob = actorOf(await user("Bob"), "editor");
      cara = actorOf(await user("Cara"), "contributor");
      const made = await createDraft(db.runner, anna, siteId, { type: "page", title: "Page" });
      if (!made.ok) throw new Error(made.message);
      pageId = made.id;
      await save(anna, 1, "saved text");
    });
    afterEach(async () => db.close());

    test("an autosave keeps one copy per person, never changes the page, and is not an earlier copy", async () => {
      const before = await loadForEdit(db.runner, anna, siteId, pageId);
      for (const text of ["one", "two", "three"])
        expect(
          await saveAutosave(
            db.runner,
            anna,
            siteId,
            pageId,
            { title: "Page, edited", blocks: [para(text)], revision: 2 },
            () => T + 1000,
          ),
        ).toMatchObject({ ok: true });
      await saveAutosave(
        db.runner,
        bob,
        siteId,
        pageId,
        { title: "Bob's", blocks: [para("bob")], revision: 2 },
        () => T + 1000,
      );
      expect(await autosaves()).toHaveLength(2);
      const after = await loadForEdit(db.runner, anna, siteId, pageId);
      expect(after).toEqual(before);
      const copies = await listRevisions(db.runner, anna, siteId, pageId);
      expect(copies.ok && copies.revisions.every((r) => !r.summary.includes("three"))).toBe(true);
      expect(copies.ok && copies.revisions).toHaveLength(1); // only the real save
      // Each person gets their own copy back, with the newest content.
      const mine = await loadAutosave(db.runner, anna, siteId, pageId);
      expect(mine.ok && mine.autosave).toMatchObject({ title: "Page, edited", revision: 2 });
      expect(JSON.stringify(mine.ok && mine.autosave)).toContain("three");
      const his = await loadAutosave(db.runner, bob, siteId, pageId);
      expect(JSON.stringify(his.ok && his.autosave)).toContain("bob");
    });

    test("a copy that equals the page is not offered, and a real save replaces the copy", async () => {
      await saveAutosave(
        db.runner,
        anna,
        siteId,
        pageId,
        { title: "Page", blocks: [para("saved text")], revision: 2 },
        () => T,
      );
      // Same text, but the editor's fresh block ids make the bodies differ: the title and text decide.
      const now = await loadForEdit(db.runner, anna, siteId, pageId);
      await saveAutosave(
        db.runner,
        anna,
        siteId,
        pageId,
        {
          title: "Page",
          blocks: now.ok ? now.entry.blocks : [],
          revision: 2,
        },
        () => T,
      );
      expect(await loadAutosave(db.runner, anna, siteId, pageId)).toEqual({
        ok: true,
        autosave: null,
      });
      await saveAutosave(
        db.runner,
        anna,
        siteId,
        pageId,
        { title: "Page", blocks: [para("more")], revision: 2 },
        () => T,
      );
      expect(await autosaves()).toHaveLength(1);
      await save(anna, 2, "more");
      expect(await autosaves()).toHaveLength(0);
    });

    test("a copy can be thrown away, and only by looking at what you may edit", async () => {
      await saveAutosave(
        db.runner,
        anna,
        siteId,
        pageId,
        { title: "Page", blocks: [para("x")], revision: 2 },
        () => T,
      );
      expect(await discardAutosave(db.runner, anna, siteId, pageId)).toEqual({ ok: true });
      expect(await autosaves()).toHaveLength(0);
      // Cara is a contributor and the page is Anna's: she may not edit it, so she may not keep a copy of it either.
      for (const result of [
        await saveAutosave(
          db.runner,
          cara,
          siteId,
          pageId,
          { title: "T", blocks: [], revision: 2 },
          () => T,
        ),
        await loadAutosave(db.runner, cara, siteId, pageId),
        await touchEditing(db.runner, cara, siteId, pageId, () => T),
      ])
        expect(result).toMatchObject({ ok: false, code: "forbidden" });
    });

    test("the editing notice names the other person, never blocks, and runs out", async () => {
      expect(await touchEditing(db.runner, anna, siteId, pageId, () => T)).toEqual({
        ok: true,
        otherEditor: null,
      });
      // Renewing your own notice is not "someone else".
      expect(await touchEditing(db.runner, anna, siteId, pageId, () => T + 30_000)).toEqual({
        ok: true,
        otherEditor: null,
      });
      // Bob sees Anna; his own touch does not push her out.
      expect(await touchEditing(db.runner, bob, siteId, pageId, () => T + 40_000)).toEqual({
        ok: true,
        otherEditor: "Anna",
      });
      expect(await touchEditing(db.runner, anna, siteId, pageId, () => T + 50_000)).toEqual({
        ok: true,
        otherEditor: null,
      });
      // Bob can still save: the notice does not lock anything.
      expect(await save(bob, 2, "bob saved")).toMatchObject({ ok: true });
      // After 90 seconds without a renewal the notice is gone and Bob takes over.
      const late = T + 50_000 + (LOCK_SECONDS + 1) * 1000;
      expect(await touchEditing(db.runner, bob, siteId, pageId, () => late)).toEqual({
        ok: true,
        otherEditor: null,
      });
      expect(await touchEditing(db.runner, anna, siteId, pageId, () => late + 1000)).toEqual({
        ok: true,
        otherEditor: "Bob",
      });
      // Leaving removes only your own notice.
      await stopEditing(db.runner, anna, pageId);
      expect(await db.runner.all(`select 1 from "entry_locks"`)).toHaveLength(1);
      await stopEditing(db.runner, bob, pageId);
      expect(await db.runner.all(`select 1 from "entry_locks"`)).toHaveLength(0);
    });
  });
}
