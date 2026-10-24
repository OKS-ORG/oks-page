// DM-17: a sort or filter on an indexed custom field uses the index, for any status filter.
// (The speed test, DM-27, is in fields.perf.test.ts.)
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildEntryList, fieldIndexName } from "./index.js";
import { openers, type TestDb } from "../testing/harness.js";
import { price, seedPriceEntries as seed, SITE } from "../testing/price-entries.js";

async function plan(db: TestDb, q: { sql: string; params: unknown[] }): Promise<string> {
  const rows = await db.run(
    (db.kind === "sqlite" ? "explain query plan " : "explain ") + q.sql,
    q.params,
  );
  return rows.map((r) => String(r["detail"] ?? r["QUERY PLAN"])).join(" | ");
}

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: field index use (20,000 entries)`, () => {
    let db: TestDb;
    const index = fieldIndexName(SITE, "product", "price");
    beforeAll(async () => {
      db = await open();
      await seed(db, 20_000);
    }, 60_000);
    afterAll(async () => db.close());

    const statuses: [string, string | string[] | undefined][] = [
      ["no status filter", undefined],
      ["published", "published"],
      ["draft", "draft"],
      ["published or private", ["published", "private"]],
    ];
    for (const [label, status] of statuses) {
      test(`DM-17 sort by the field, ${label}: the index is used`, async () => {
        for (const direction of ["asc", "desc"] as const) {
          const p = await plan(
            db,
            buildEntryList(kind, {
              siteId: SITE,
              typeKey: "product",
              status,
              sort: { field: price, direction },
              limit: 20,
            }),
          );
          expect(p, `${direction}: ${p}`).toContain(index);
        }
      });
      // A filter on its own may be answered from another index (for example the list index, ordered by update time),
      // which is a fair choice for the database. The filter is tested together with a sort on the same field.
      test(`DM-17 filter and sort by the field, ${label}: the index is used`, async () => {
        const p = await plan(
          db,
          buildEntryList(kind, {
            siteId: SITE,
            typeKey: "product",
            status,
            filters: [{ field: price, op: "gte", value: 990 }],
            sort: { field: price },
            limit: 20,
          }),
        );
        expect(p, p).toContain(index);
      });
    }

    test("control: a query that writes the expression another way does not use the index (why the builder is the only way)", async () => {
      const sql =
        kind === "sqlite"
          ? `select id from entries where site_id = ? and type_key = 'product' and json_extract(fields, '$.price') >= 990 order by json_extract(fields, '$.price') limit 20`
          : `select id from entries where site_id = ? and type_key = 'product' and (fields ->> 'price') >= '990' order by (fields ->> 'price') limit 20`;
      const p = await plan(db, { sql, params: [SITE] });
      if (kind === "sqlite") expect(p).toMatch(/TEMP B-TREE|SCAN/);
      expect(p.includes(`${index} (site_id=?)`) || !p.includes(index), p).toBe(true);
    });
  });
}
