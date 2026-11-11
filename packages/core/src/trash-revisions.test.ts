// The trash and the revisions of an entry, on SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, listEntries, loadForEdit, saveContent, type Actor } from "./content.js";
import { compareRevision, listRevisions, restoreRevision } from "./revisions.js";
import { diffLines, summarise } from "./revision-parts.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import { deleteForever, listTrash, purgeTrash, restoreEntry, trashEntry } from "./trash.js";

const T = new Date(1_700_000_000_000);
const DAY = 86_400_000;
const text = (value: string) => ({ type: "text", text: value, styles: {} });
const para = (value: string) => ({
  id: newId(),
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
  describe.skipIf(skip)(`${kind}: trash and revisions`, () => {
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
    const save = async (actor: Actor, id: string, revision: number, over = {}, at?: number) => {
      const saved = await saveContent(
        db.runner,
        actor,
        siteId,
        id,
        { title: "T", slugPart: "t", status: "draft", blocks: [para("hello")], revision, ...over },
        () => at ?? T.getTime() + tick++ * 1000,
      );
      if (!saved.ok) throw new Error(saved.message);
      return saved;
    };
    let tick = 0;
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await db.runner.all(sql, params))[0]!["n"]);

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

    test("moving to the trash takes an entry out of the lists and the editor, and it can be seen in the trash", async () => {
      const page = await draft(bob, "Old news");
      const moved = await trashEntry(db.runner, bob, siteId, page.id, () => T.getTime());
      expect(moved).toMatchObject({ ok: true, type: "page", wasPublished: false });
      expect(await listEntries(db.runner, anna, siteId, "page")).toEqual([]);
      expect(await loadForEdit(db.runner, anna, siteId, page.id)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      const trash = await listTrash(db.runner, bob, siteId, "page", () => T.getTime() + 2 * DAY);
      expect(trash).toHaveLength(1);
      expect(trash[0]).toMatchObject({ id: page.id, title: "Old news", daysLeft: 28 });
    });

    test("a published entry reports that it was live, so the site can refresh", async () => {
      const page = await draft(anna, "Live");
      await save(anna, page.id, 1, { status: "published" });
      const moved = await trashEntry(db.runner, anna, siteId, page.id);
      expect(moved).toMatchObject({ ok: true, wasPublished: true });
    });

    test("who may delete: an author their own, an editor any, a subscriber nothing, nobody twice", async () => {
      const mine = await draft(bob, "Mine");
      const hers = await draft(cara, "Hers");
      expect(await trashEntry(db.runner, bob, siteId, hers.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await trashEntry(db.runner, sam, siteId, mine.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await trashEntry(db.runner, eve, siteId, hers.id)).toMatchObject({ ok: true });
      expect(await trashEntry(db.runner, eve, siteId, hers.id)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(await trashEntry(db.runner, bob, siteId, mine.id)).toMatchObject({ ok: true });
      // The trash list shows an author only their own.
      expect(await listTrash(db.runner, bob, siteId, "page")).toHaveLength(1);
      expect(await listTrash(db.runner, eve, siteId, "page")).toHaveLength(2);
      expect(await listTrash(db.runner, sam, siteId, "page")).toEqual([]);
    });

    test("restoring brings it back as a draft; a taken address gets -2", async () => {
      const first = await draft(anna, "Hello");
      await trashEntry(db.runner, anna, siteId, first.id);
      const second = await draft(anna, "Hello");
      expect(second.slug).toBe("hello"); // the trashed one gave its address up
      const back = await restoreEntry(db.runner, anna, siteId, first.id);
      expect(back).toMatchObject({ ok: true, slug: "hello-2" });
      const loaded = await loadForEdit(db.runner, anna, siteId, first.id);
      expect(loaded).toMatchObject({ ok: true, entry: { status: "draft", slugPart: "hello-2" } });
      expect(await restoreEntry(db.runner, anna, siteId, first.id)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });

    test("delete forever needs the trash first, and takes the revisions with it", async () => {
      const page = await draft(anna, "Gone");
      await save(anna, page.id, 1);
      expect(await deleteForever(db.runner, anna, siteId, page.id)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      await trashEntry(db.runner, anna, siteId, page.id);
      expect(await deleteForever(db.runner, bob, siteId, page.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await deleteForever(db.runner, anna, siteId, page.id)).toMatchObject({ ok: true });
      expect(await count(`select count(*) as n from "entries" where "id" = ?`, [page.id])).toBe(0);
      expect(
        await count(`select count(*) as n from "entry_revisions" where "entry_id" = ?`, [page.id]),
      ).toBe(0);
    });

    test("the trash empties itself after 30 days and keeps what is newer", async () => {
      const old = await draft(anna, "Old");
      const fresh = await draft(anna, "Fresh");
      await trashEntry(db.runner, anna, siteId, old.id, () => T.getTime());
      await trashEntry(db.runner, anna, siteId, fresh.id, () => T.getTime() + 20 * DAY);
      expect(await purgeTrash(db.runner, () => T.getTime() + 29 * DAY)).toBe(0);
      expect(await purgeTrash(db.runner, () => T.getTime() + 31 * DAY)).toBe(1);
      const left = await listTrash(db.runner, anna, siteId, "page", () => T.getTime() + 31 * DAY);
      expect(left.map((e) => e.title)).toEqual(["Fresh"]);
    });

    test("every save keeps a copy with who, when and what changed", async () => {
      const page = await draft(bob, "First title");
      const one = para("one");
      const slugPart = "first-title";
      const a = await save(bob, page.id, 1, { title: "First title", slugPart, blocks: [one] });
      const b = await save(bob, page.id, a.revision, {
        title: "Second title",
        slugPart,
        blocks: [one],
      });
      await save(bob, page.id, b.revision, {
        title: "Second title",
        slugPart,
        status: "published",
        blocks: [para("two")],
      });
      const listed = await listRevisions(db.runner, bob, siteId, page.id);
      if (!listed.ok) throw new Error(listed.message);
      expect(listed.revisions.map((r) => r.summary)).toEqual([
        "Published it, changed the text",
        "Changed the title",
        "Changed the text",
      ]);
      expect(listed.revisions[0]!.authorName).toBe("Bob");
    });

    test("only people who may edit an entry see its revisions", async () => {
      const page = await draft(bob, "Private");
      await save(bob, page.id, 1);
      expect(await listRevisions(db.runner, cara, siteId, page.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await listRevisions(db.runner, eve, siteId, page.id)).toMatchObject({ ok: true });
    });

    test("an older copy can be compared with the page as it is now", async () => {
      const page = await draft(anna, "Story");
      const a = await save(anna, page.id, 1, { blocks: [para("alpha"), para("beta")] });
      await save(anna, page.id, a.revision, {
        title: "Story 2",
        blocks: [para("alpha"), para("gamma")],
      });
      const listed = await listRevisions(db.runner, anna, siteId, page.id);
      if (!listed.ok) throw new Error(listed.message);
      const oldest = listed.revisions.at(-1)!;
      const compared = await compareRevision(db.runner, anna, siteId, page.id, oldest.id);
      if (!compared.ok) throw new Error(compared.message);
      expect(compared.compare.title).toEqual({ before: "T", now: "Story 2" });
      const kinds = compared.compare.lines.map((l) => `${l.kind}:${l.text}`);
      expect(kinds).toContain("same:alpha");
      expect(kinds).toContain("removed:beta");
      expect(kinds).toContain("added:gamma");
    });

    test("restoring puts the old content back as a new save, and keeps the status and the address", async () => {
      const page = await draft(anna, "Doc");
      const a = await save(anna, page.id, 1, {
        title: "Doc v1",
        slugPart: "doc",
        blocks: [para("v1")],
      });
      const b = await save(anna, page.id, a.revision, {
        title: "Doc v2",
        slugPart: "doc-new",
        status: "published",
        blocks: [para("v2")],
      });
      const listed = await listRevisions(db.runner, anna, siteId, page.id);
      if (!listed.ok) throw new Error(listed.message);
      const v1 = listed.revisions.at(-1)!;
      const restored = await restoreRevision(db.runner, anna, siteId, page.id, v1.id, b.revision);
      expect(restored).toMatchObject({ ok: true, status: "published", slug: "doc-new" });
      const loaded = await loadForEdit(db.runner, anna, siteId, page.id);
      if (!loaded.ok) throw new Error(loaded.message);
      expect(loaded.entry.title).toBe("Doc v1");
      expect(JSON.stringify(loaded.entry.blocks)).toContain("v1");
      const after = await listRevisions(db.runner, anna, siteId, page.id);
      if (!after.ok) throw new Error(after.message);
      expect(after.revisions).toHaveLength(3);
      expect(after.revisions[0]!.summary).toMatch(/^Restored the copy from /);
    });

    test("restoring from an old editor state is refused as a clash, like any save", async () => {
      const page = await draft(anna, "Clash");
      const a = await save(anna, page.id, 1);
      await save(anna, page.id, a.revision, { title: "Newer" });
      const listed = await listRevisions(db.runner, anna, siteId, page.id);
      if (!listed.ok) throw new Error(listed.message);
      const result = await restoreRevision(
        db.runner,
        anna,
        siteId,
        page.id,
        listed.revisions[0]!.id,
        a.revision,
      );
      expect(result).toMatchObject({ ok: false, code: "conflict" });
    });

    test("copies older than 30 days go, except the last 25 of the entry", async () => {
      const page = await draft(anna, "Busy");
      let rev = 1;
      for (let i = 0; i < 30; i++)
        rev = (await save(anna, page.id, rev, { blocks: [para(`v${i}`)] }, T.getTime() + i * 1000))
          .revision;
      expect(
        await count(`select count(*) as n from "entry_revisions" where "entry_id" = ?`, [page.id]),
      ).toBe(30); // all are recent, so all are kept
      await save(anna, page.id, rev, { blocks: [para("late")] }, T.getTime() + 40 * DAY);
      expect(
        await count(`select count(*) as n from "entry_revisions" where "entry_id" = ?`, [page.id]),
      ).toBe(25);
      const listed = await listRevisions(db.runner, anna, siteId, page.id);
      if (!listed.ok) throw new Error(listed.message);
      expect(listed.revisions).toHaveLength(25);
    });
  });
}

describe("revision summaries and compare", () => {
  const base = { title: "A", slug: "a", status: "draft", plainText: "x", bodyJson: "1" };
  test("summaries are in plain words", () => {
    expect(summarise(null, base)).toBe("First save");
    expect(summarise(base, base)).toBe("Saved with no changes");
    expect(summarise(base, { ...base, bodyJson: "2" })).toBe("Changed pictures or layout");
    expect(summarise(base, { ...base, slug: "b" })).toBe("Changed the address");
    expect(summarise({ ...base, status: "published" }, base)).toBe("Made it a draft");
  });
  test("the line compare finds what was removed and added", () => {
    expect(diffLines("a\nb\nc", "a\nc\nd").map((l) => `${l.kind[0]}${l.text}`)).toEqual([
      "sa",
      "rb",
      "sc",
      "ad",
    ]);
    expect(diffLines("", "x")).toEqual([{ kind: "added", text: "x" }]);
  });
});
