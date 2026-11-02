// Makes a small SQLite database for the hosting baseline (S8): a home page and 50 posts, the same data as the memory test.
// Usage: tsx apps/site/test/make-sample-db.ts /path/to/site.sqlite
import { openSqlite } from "@oks-page/db/testing";
import { seed } from "./helpers";

const file = process.argv[2];
if (!file) throw new Error("Usage: make-sample-db.ts /path/to/site.sqlite");
const db = await openSqlite(file);
const s = await seed(db);
await s.entry("home", "Home");
for (let i = 0; i < 50; i++) await s.entry(`blog/post-${i}`, `Post ${i}`, "published", "post");
await db.close();
console.log(`Made ${file}`);
