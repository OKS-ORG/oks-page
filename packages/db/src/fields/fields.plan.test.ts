// DM-17 (a sort or filter on an indexed custom field uses the index, for any status filter) and
// DM-27 (100,000 entries: listing 20 of a type sorted by an indexed field takes under 10 ms).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildEntryList, fieldIndexName, syncFieldIndexes } from "./index.js";
import { ms, openers, type TestDb } from "../testing/harness.js";

const SITE = "SITE0000000000000000000001";
const USER = "USER0000000000000000000001";
const CT = "CT000000000000000000000001";
const T = ms(1_700_000_000_000);
const price = { key: "price", kind: "number" as const };

async function seed(db: TestDb, total: number) {
  await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
    SITE,
    T,
    T,
  ]);
  await db.run(
    "insert into users (id, name, email, created_at, updated_at) values (?, 'U', 'u@example.com', ?, ?)",
    [USER, T, T],
  );
  await db.run(
    "insert into content_types (id, site_id, key, label, url_rule, options, created_at, updated_at) values (?, ?, 'product', 'Product', '/{slug}', '{}', ?, ?)",
    [CT, SITE, T, T],
  );
  await db.run(
    "insert into field_definitions (id, content_type_id, key, label, field_type, validation, options, is_sortable, is_filterable) values ('FD000000000000000000000001', ?, 'price', 'Price', 'number', '{}', '{}', ?, ?)",
    [CT, true, true],
  );
  // Half of the entries are products, half are posts; statuses rotate; prices run from 0 to 996.
  if (db.kind === "sqlite") {
    await db.run(
      `with recursive c(i) as (select 1 union all select i + 1 from c where i < ${total})
       insert into entries (id, site_id, type_key, title, slug, author_id, status, fields, body, seo, meta, created_at, updated_at)
       select printf('E%025d', i), '${SITE}', case when i % 2 = 0 then 'product' else 'post' end, 't' || i, 's' || i, '${USER}',
              case i % 3 when 0 then 'published' when 1 then 'draft' else 'private' end,
              json_object('price', i % 997), '[]', '{}', '{}', 1700000000000, 1700000000000 + i from c`,
    );
  } else {
    await db.run(
      `insert into entries (id, site_id, type_key, title, slug, author_id, status, fields, body, seo, meta, created_at, updated_at)
       select 'E' || lpad(g::text, 25, '0'), '${SITE}', case when g % 2 = 0 then 'product' else 'post' end, 't' || g, 's' || g, '${USER}',
              case g % 3 when 0 then 'published' when 1 then 'draft' else 'private' end,
              jsonb_build_object('price', g % 997), '[]', '{}', '{}', to_timestamp(1700000000), to_timestamp(1700000000 + g / 1000.0)
         from generate_series(1, ${total}) g`,
    );
    await db.run("analyze entries");
  }
  const runner: SqlRunner = {
    dialect: db.kind,
    all: (s, p) => db.run(s, p),
    exec: async (s) => void (await db.run(s)),
  };
  await syncFieldIndexes(runner);
}

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

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: DM-27 speed with 100,000 entries`, () => {
    test("listing 20 entries of a type sorted by an indexed field takes under 10 ms", async () => {
      const db = await open();
      try {
        await seed(db, 100_000);
        const q = buildEntryList(kind, {
          siteId: SITE,
          typeKey: "product",
          status: "published",
          sort: { field: price },
          limit: 20,
        });
        await db.run(q.sql, q.params);
        const times: number[] = [];
        for (let i = 0; i < 40; i++) {
          const start = performance.now();
          const rows = await db.run(q.sql, q.params);
          times.push(performance.now() - start);
          expect(rows).toHaveLength(20);
        }
        times.sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)]!;
        console.log(
          `${kind}: median ${median.toFixed(2)} ms, slowest ${times.at(-1)!.toFixed(2)} ms`,
        );
        expect(median).toBeLessThan(10);
      } finally {
        await db.close();
      }
    }, 180_000);
  });
}
