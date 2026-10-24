// Child process for the migration lock test: node migrate-worker.mjs <sqlite file> <migrations folder>
import Database from "better-sqlite3";
import { migrateSqlite } from "../migrate.ts";

const [file, folder] = process.argv.slice(2);
const db = new Database(file);
db.pragma("busy_timeout = 30000");
const applied = migrateSqlite(db, folder);
console.log(JSON.stringify(applied));
db.close();
