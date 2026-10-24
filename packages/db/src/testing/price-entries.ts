// A data set for the speed and plan tests: many entries of two types, with a sortable price field.
import { syncFieldIndexes } from "../fields/index.js";
import { ms, type TestDb } from "./harness.js";

export const SITE = "SITE0000000000000000000001";
const USER = "USER0000000000000000000001";
const CT = "CT000000000000000000000001";
const T = ms(1_700_000_000_000);
export const price = { key: "price", kind: "number" as const };

export async function seedPriceEntries(db: TestDb, total: number) {
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
  await syncFieldIndexes(db.runner);
}
