// Spec 01, section 4: automatic indexes for custom fields. DM-17 (the index is used), DM-18 (create and
// drop follow the field definition) and the builder rules, on SQLite and PostgreSQL.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildEntryList, fieldExpression, fieldIndexName, syncFieldIndexes } from "./index.js";
import { ms, openers, type TestDb } from "../testing/harness.js";

let n = 0;
const id = (tag: string) =>
  `${tag.toUpperCase().padEnd(8, "0")}${String(++n).padStart(18, "0")}`.slice(0, 26);
const T = ms(1_700_000_000_000);

const runner = (db: TestDb) => db.runner;

async function seed(db: TestDb) {
  const site = id("site");
  const user = id("user");
  await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
    site,
    T,
    T,
  ]);
  await db.run(
    "insert into users (id, name, email, created_at, updated_at) values (?, 'U', 'u@example.com', ?, ?)",
    [user, T, T],
  );
  return { site, user };
}
async function addType(db: TestDb, site: string, key: string) {
  const ct = id("ct");
  await db.run(
    "insert into content_types (id, site_id, key, label, url_rule, options, created_at, updated_at) values (?, ?, ?, ?, '/{slug}', '{}', ?, ?)",
    [ct, site, key, key, T, T],
  );
  return ct;
}
async function addField(
  db: TestDb,
  ct: string,
  key: string,
  fieldType: string,
  flags: { sortable?: boolean; filterable?: boolean } = {},
) {
  const fd = id("fd");
  await db.run(
    "insert into field_definitions (id, content_type_id, key, label, field_type, validation, options, is_sortable, is_filterable) values (?, ?, ?, ?, ?, '{}', '{}', ?, ?)",
    [fd, ct, key, key, fieldType, flags.sortable ?? false, flags.filterable ?? false],
  );
  return fd;
}
const indexNames = async (db: TestDb) =>
  (db.kind === "sqlite"
    ? await db.run(
        "select name from sqlite_master where type = 'index' and name like 'ix_ef_%' order by name",
      )
    : await db.run(
        "select indexname as name from pg_indexes where schemaname = current_schema() and indexname like 'ix_ef_%' order by indexname",
      )
  ).map((r) => String(r["name"]));

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: custom field indexes`, () => {
    let db: TestDb;
    beforeEach(async () => (db = await open()));
    afterEach(async () => db.close());

    test("DM-18 marking a field sortable creates the index; unmarking drops it", async () => {
      const { site } = await seed(db);
      const ct = await addType(db, site, "product");
      const fd = await addField(db, ct, "price", "number", { sortable: true });
      expect((await syncFieldIndexes(runner(db))).created).toEqual([
        fieldIndexName(site, "product", "price"),
      ]);
      expect(await indexNames(db)).toEqual([fieldIndexName(site, "product", "price")]);
      expect(await syncFieldIndexes(runner(db))).toEqual({ created: [], dropped: [] });
      await db.run("update field_definitions set is_sortable = ? where id = ?", [false, fd]);
      expect((await syncFieldIndexes(runner(db))).dropped).toHaveLength(1);
      expect(await indexNames(db)).toEqual([]);
    });

    test("DM-18 a field that is both sortable and filterable has one index; fields of other types and sites have their own", async () => {
      const { site } = await seed(db);
      const other = id("site");
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S2', ?, ?)", [
        other,
        T,
        T,
      ]);
      const a = await addType(db, site, "product");
      const b = await addType(db, site, "event");
      const c = await addType(db, other, "product");
      await addField(db, a, "price", "number", { sortable: true, filterable: true });
      await addField(db, b, "price", "number", { filterable: true });
      await addField(db, c, "price", "number", { sortable: true });
      await syncFieldIndexes(runner(db));
      expect(await indexNames(db)).toHaveLength(3);
    });

    test("DM-18 fields that are not simple values get no index, and nothing breaks", async () => {
      const { site } = await seed(db);
      const ct = await addType(db, site, "product");
      await addField(db, ct, "gallery", "media", { sortable: true });
      await addField(db, ct, "body", "rich text (blocks)", { filterable: true });
      expect(await syncFieldIndexes(runner(db))).toEqual({ created: [], dropped: [] });
    });

    test("DM-18 a restored backup gets the same indexes back from the field definitions", async () => {
      const first = await seed(db);
      const ct = await addType(db, first.site, "product");
      await addField(db, ct, "price", "number", { sortable: true });
      await syncFieldIndexes(runner(db));
      const before = await indexNames(db);
      // Drop the index as if the backup had only the data, then run the startup sync.
      for (const name of before) await db.run(`drop index "${name}"`);
      expect(await indexNames(db)).toEqual([]);
      await syncFieldIndexes(runner(db));
      expect(await indexNames(db)).toEqual(before);
    });

    test("builder: keys that could change the SQL are refused", () => {
      expect(() => fieldExpression(kind, "price') or 1=1 --", "number")).toThrow(
        /Invalid field key/,
      );
      expect(() =>
        buildEntryList(kind, { siteId: "s", typeKey: "x'; drop table entries; --", limit: 10 }),
      ).toThrow(/Invalid content type key/);
      expect(() => buildEntryList(kind, { siteId: "s", typeKey: "post", limit: 0 })).toThrow(
        /limit/,
      );
    });

    test("builder: filter and sort return the right entries in the right order", async () => {
      const { site, user } = await seed(db);
      const price = { key: "price", kind: "number" as const };
      const insert = (title: string, p: number, status: string, type = "product") =>
        db.run(
          "insert into entries (id, site_id, type_key, title, slug, author_id, status, fields, body, seo, meta, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', '{}', ?, ?)",
          [
            id("e"),
            site,
            type,
            title,
            title.toLowerCase(),
            user,
            status,
            JSON.stringify({ price: p }),
            T,
            T,
          ],
        );
      await insert("A", 30, "published");
      await insert("B", 5, "published");
      await insert("C", 12, "draft");
      await insert("D", 100, "published");
      await insert("Post", 1, "published", "post");
      const run = async (q: ReturnType<typeof buildEntryList>) =>
        (await db.run(q.sql, q.params)).map((r) => r["title"]);
      expect(
        await run(
          buildEntryList(kind, {
            siteId: site,
            typeKey: "product",
            status: "published",
            sort: { field: price },
            limit: 10,
          }),
        ),
      ).toEqual(["B", "A", "D"]);
      expect(
        await run(
          buildEntryList(kind, {
            siteId: site,
            typeKey: "product",
            sort: { field: price, direction: "desc" },
            limit: 2,
          }),
        ),
      ).toEqual(["D", "A"]);
      expect(
        await run(
          buildEntryList(kind, {
            siteId: site,
            typeKey: "product",
            filters: [
              { field: price, op: "gte", value: 12 },
              { field: price, op: "lt", value: 100 },
            ],
            sort: { field: price },
            limit: 10,
          }),
        ),
      ).toEqual(["C", "A"]);
    });
  });
}
