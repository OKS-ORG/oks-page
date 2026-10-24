// DM-32 (of 1,000 saves from the same old revision, exactly one wins) and DM-22 (a save updates entry_media in
// the same transaction; a failed save leaves nothing behind), on SQLite and PostgreSQL.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { saveEntry } from "./save.js";
import { pgRunner } from "../runner.js";
import { ms, openers, type TestDb } from "../testing/harness.js";

let n = 0;
const id = (tag: string) =>
  `${tag.toUpperCase().padEnd(8, "0")}${String(++n).padStart(18, "0")}`.slice(0, 26);
const T = ms(1_700_000_000_000);

async function seed(db: TestDb) {
  const site = id("site");
  const user = id("user");
  const entry = id("entry");
  await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
    site,
    T,
    T,
  ]);
  await db.run(
    "insert into users (id, name, email, created_at, updated_at) values (?, 'U', 'u@example.com', ?, ?)",
    [user, T, T],
  );
  await db.run(
    "insert into entries (id, site_id, type_key, title, slug, author_id, fields, body, seo, meta, created_at, updated_at) values (?, ?, 'post', 'Start', 'start', ?, '{}', '[]', '{}', '{}', ?, ?)",
    [entry, site, user, T, T],
  );
  return { site, user, entry };
}
const addMedia = async (db: TestDb, site: string, user: string, key: string) => {
  const m = id("media");
  await db.run(
    "insert into media (id, site_id, storage_key, filename, mime_type, size_bytes, content_hash, uploaded_by, created_at) values (?, ?, ?, ?, 'image/png', 1, 'h', ?, ?)",
    [m, site, key, key, user, T],
  );
  return m;
};
const row = async (db: TestDb, entry: string) =>
  (await db.run("select title, revision, fields from entries where id = ?", [entry]))[0]!;

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the save rule`, () => {
    let db: TestDb;
    beforeEach(async () => (db = await open()));
    afterEach(async () => db.close());

    test("AD-20 a save from the current revision works and raises the revision by one", async () => {
      const { entry } = await seed(db);
      const result = await saveEntry(db.runner, {
        entryId: entry,
        fromRevision: 1,
        changes: { title: "New", fields: { price: 5 } },
      });
      expect(result).toEqual({ ok: true, revision: 2 });
      const r = await row(db, entry);
      expect(r["title"]).toBe("New");
      expect(Number(r["revision"])).toBe(2);
      expect(typeof r["fields"] === "string" ? JSON.parse(r["fields"]) : r["fields"]).toEqual({
        price: 5,
      });
    });

    test("AD-21 a stale save is refused, says which revision is current, and changes nothing", async () => {
      const { entry } = await seed(db);
      await saveEntry(db.runner, { entryId: entry, fromRevision: 1, changes: { title: "First" } });
      const stale = await saveEntry(db.runner, {
        entryId: entry,
        fromRevision: 1,
        changes: { title: "Second" },
      });
      expect(stale).toEqual({ ok: false, reason: "conflict", currentRevision: 2 });
      expect((await row(db, entry))["title"]).toBe("First");
    });

    test("AD-22 after reloading the new revision, the save works", async () => {
      const { entry } = await seed(db);
      await saveEntry(db.runner, { entryId: entry, fromRevision: 1, changes: { title: "First" } });
      expect(
        await saveEntry(db.runner, {
          entryId: entry,
          fromRevision: 2,
          changes: { title: "Second" },
        }),
      ).toEqual({ ok: true, revision: 3 });
    });

    test("a save of an entry that does not exist says so", async () => {
      await seed(db);
      expect(
        await saveEntry(db.runner, {
          entryId: id("gone"),
          fromRevision: 1,
          changes: { title: "x" },
        }),
      ).toEqual({ ok: false, reason: "not_found" });
    });

    test("a column that a save may not change is refused before any SQL runs", async () => {
      const { entry } = await seed(db);
      await expect(
        saveEntry(db.runner, {
          entryId: entry,
          fromRevision: 1,
          changes: { ["id" as "title"]: "x" },
        }),
      ).rejects.toThrow(/not a column a save may change/);
      await expect(
        saveEntry(db.runner, {
          entryId: entry,
          fromRevision: 1,
          changes: { ["title\" = 'x', \"revision" as "title"]: "x" },
        }),
      ).rejects.toThrow(/not a column/);
    });

    test("DM-32 of 1,000 saves from the same old revision, exactly one wins", async () => {
      const { entry } = await seed(db);
      // PostgreSQL: 20 real connections racing. SQLite: one connection, so the saves queue up, but the rule is the same.
      const runner = db.kind === "postgres" ? pgRunner(db.pool!(20)) : db.runner;
      const results = await Promise.all(
        Array.from({ length: 1000 }, (_, i) =>
          saveEntry(runner, { entryId: entry, fromRevision: 1, changes: { title: `Save ${i}` } }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === "conflict")).toHaveLength(999);
      const winner = results.findIndex((r) => r.ok);
      const r = await row(db, entry);
      expect(Number(r["revision"])).toBe(2);
      expect(r["title"]).toBe(`Save ${winner}`);
    }, 60_000);

    test("DM-22 a save replaces the list of files the entry uses, in the same transaction", async () => {
      const { site, user, entry } = await seed(db);
      const a = await addMedia(db, site, user, "a.png");
      const b = await addMedia(db, site, user, "b.png");
      await saveEntry(db.runner, {
        entryId: entry,
        fromRevision: 1,
        changes: {},
        media: [{ mediaId: a, field: "featured" }],
      });
      await saveEntry(db.runner, {
        entryId: entry,
        fromRevision: 2,
        changes: {},
        media: [{ mediaId: b, field: "body" }],
      });
      const rows = await db.run("select media_id, field from entry_media where entry_id = ?", [
        entry,
      ]);
      expect(rows).toEqual([{ media_id: b, field: "body" }]);
    });

    test("DM-22 a failed save leaves nothing behind: the entry, its revision and its file list are unchanged", async () => {
      const { site, user, entry } = await seed(db);
      const a = await addMedia(db, site, user, "a.png");
      await saveEntry(db.runner, {
        entryId: entry,
        fromRevision: 1,
        changes: {},
        media: [{ mediaId: a, field: "featured" }],
      });
      await expect(
        saveEntry(db.runner, {
          entryId: entry,
          fromRevision: 2,
          changes: { title: "Broken" },
          media: [{ mediaId: id("nomedia"), field: "body" }],
        }),
      ).rejects.toThrow();
      const r = await row(db, entry);
      expect(r["title"]).toBe("Start");
      expect(Number(r["revision"])).toBe(2);
      expect(
        await db.run("select media_id, field from entry_media where entry_id = ?", [entry]),
      ).toEqual([{ media_id: a, field: "featured" }]);
    });

    test("DM-22 a stale save does not touch the file list", async () => {
      const { site, user, entry } = await seed(db);
      const a = await addMedia(db, site, user, "a.png");
      await saveEntry(db.runner, {
        entryId: entry,
        fromRevision: 1,
        changes: {},
        media: [{ mediaId: a, field: "featured" }],
      });
      const stale = await saveEntry(db.runner, {
        entryId: entry,
        fromRevision: 1,
        changes: {},
        media: [],
      });
      expect(stale.ok).toBe(false);
      expect(
        await db.run("select count(*) as c from entry_media where entry_id = ?", [entry]),
      ).toHaveLength(1);
      expect(
        Number(
          (await db.run("select count(*) as c from entry_media where entry_id = ?", [entry]))[0]![
            "c"
          ],
        ),
      ).toBe(1);
    });
  });
}
