// Migration runner for SQLite and PostgreSQL (spec 01, DM-20 and DM-21).
//
// It reads the folder drizzle-kit writes (`meta/_journal.json` plus one `.sql` file per migration) and
// applies what is missing, in order, inside one transaction, while holding a lock:
//   SQLite:     BEGIN IMMEDIATE (a second process waits for the write lock)
//   PostgreSQL: a session advisory lock
// So two servers that start together migrate once. Applied migrations are recorded in `oks_migrations`
// with a hash of the file, and a changed file or a database that is newer than the code is an error.
//
// This file avoids runtime-only TypeScript syntax and relative imports, so Node can run it directly
// (the migration tests start it in child processes).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type pg from "pg";

export interface Migration {
  tag: string;
  hash: string;
  statements: string[];
}

interface Journal {
  entries: { idx: number; tag: string }[];
}

export function readMigrations(folder: string): Migration[] {
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => {
      const sql = readFileSync(join(folder, `${e.tag}.sql`), "utf8");
      return {
        tag: e.tag,
        hash: createHash("sha256").update(sql).digest("hex"),
        statements: sql
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    });
}

/** Where the migration files of each database are (inside this package, next to `dist`). */
export function migrationsFolder(dialect: "sqlite" | "postgres"): string {
  // Next.js bundles this package into the server and leaves `import.meta.dirname` empty; the file URL still works.
  const here = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "drizzle", dialect === "sqlite" ? "sqlite" : "pg");
}

export interface MigrateOptions {
  /** Apply only the first N migrations (used by the upgrade tests). */
  upTo?: number;
}

/** What to do with the migrations already recorded in the database. */
function plan(
  all: Migration[],
  applied: { tag: string; hash: string }[],
  upTo?: number,
): Migration[] {
  const known = new Map(all.map((m) => [m.tag, m]));
  for (const a of applied) {
    const m = known.get(a.tag);
    if (!m)
      throw new Error(
        `The database has migration "${a.tag}", which this version of the code does not know. The database is newer than the code.`,
      );
    if (m.hash !== a.hash)
      throw new Error(
        `Migration "${a.tag}" was changed after it was applied. Never edit an applied migration; add a new one.`,
      );
  }
  const done = new Set(applied.map((a) => a.tag));
  return all.slice(0, upTo ?? all.length).filter((m) => !done.has(m.tag));
}

export function migrateSqlite(
  db: Database.Database,
  folder: string,
  options: MigrateOptions = {},
): string[] {
  const all = readMigrations(folder);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "create table if not exists oks_migrations (tag text primary key, hash text not null, applied_at integer not null)",
    );
    const applied = db.prepare("select tag, hash from oks_migrations").all() as {
      tag: string;
      hash: string;
    }[];
    const todo = plan(all, applied, options.upTo);
    const insert = db.prepare(
      "insert into oks_migrations (tag, hash, applied_at) values (?, ?, ?)",
    );
    for (const m of todo) {
      for (const s of m.statements) db.exec(s);
      insert.run(m.tag, m.hash, Date.now());
    }
    db.exec("COMMIT");
    return todo.map((m) => m.tag);
  } catch (e) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

/** One number for the advisory lock; the same on every server. */
const LOCK_KEY = 7_203_104_551;

export interface MigratePgOptions extends MigrateOptions {
  /** The schema to migrate. drizzle-kit writes "public" in foreign keys; it is replaced when this differs. Default "public". */
  schema?: string;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function migratePg(
  client: pg.Client,
  folder: string,
  options: MigratePgOptions = {},
): Promise<string[]> {
  const all = readMigrations(folder);
  const schema = options.schema ?? "public";
  await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query("begin");
    try {
      await client.query(`set local search_path to ${quote(schema)}`);
      await client.query(
        "create table if not exists oks_migrations (tag text primary key, hash text not null, applied_at timestamptz(3) not null)",
      );
      const applied = (await client.query("select tag, hash from oks_migrations")).rows as {
        tag: string;
        hash: string;
      }[];
      const todo = plan(all, applied, options.upTo);
      for (const m of todo) {
        for (const s of m.statements)
          await client.query(
            schema === "public" ? s : s.replaceAll('"public".', `${quote(schema)}.`),
          );
        await client.query(
          "insert into oks_migrations (tag, hash, applied_at) values ($1, $2, now())",
          [m.tag, m.hash],
        );
      }
      await client.query("commit");
      return todo.map((m) => m.tag);
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}
