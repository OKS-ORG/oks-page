import { openSqlite } from "../../../packages/db/src/testing/harness";
import { seed } from "./helpers";
const db = await openSqlite("/tmp/oks-site.db");
const { entry } = await seed(db);
await entry("home", "Home");
await entry("about", "About");
await entry("blog/hello", "Hello", "published", "post");
await db.close();
console.log("seeded");
