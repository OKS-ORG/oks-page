// A throw-away database in memory with every migration applied, for tools that need a real one for a moment (`oks check`).
import Database from "better-sqlite3";
import { join } from "node:path";
import { migrateSqlite } from "./migrate.js";
import { sqliteRunner, type SqlRunner } from "./runner.js";

const folder = join(import.meta.dirname, "..", "drizzle", "sqlite");

export function openMemoryDatabase(): { runner: SqlRunner; close(): void } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSqlite(db, folder);
  return { runner: sqliteRunner(db), close: () => void db.close() };
}
