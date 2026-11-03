// Makes a small SQLite database for the hosting baseline (S8): a home page and 50 posts, the same data as the memory test.
// Needs the packages built first (`pnpm exec tsc -b`). Usage: node apps/site/test/make-sample-db.mjs /path/to/site.sqlite
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite } from "../../../packages/db/dist/testing/harness.js";

const file = process.argv[2];
if (!file) throw new Error("Usage: make-sample-db.mjs /path/to/site.sqlite");
mkdirSync(dirname(file), { recursive: true });

const db = await openSqlite(file);
const T = 1_700_000_000_000;
const site = "SITE0000000000000000000001";
const user = "USER0000000000000000000001";
await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
  site,
  T,
  T,
]);
await db.run(
  "insert into users (id, name, email, created_at, updated_at) values (?, 'U', 'u@example.com', ?, ?)",
  [user, T, T],
);
let n = 0;
const entry = (slug, title, type) =>
  db.run(
    "insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, created_at, updated_at) values (?, ?, ?, 'published', ?, ?, ?, '{}', '[]', ?, ?, '{}', '{}', ?, ?)",
    [
      `ENT${String(++n).padStart(23, "0")}`,
      site,
      type,
      title,
      slug,
      user,
      title,
      `<p>${title} body</p>`,
      T,
      T,
    ],
  );
await entry("home", "Home", "page");
for (let i = 0; i < 50; i++) await entry(`blog/post-${i}`, `Post ${i}`, "post");
await db.close();
console.log(`Made ${file}`);
