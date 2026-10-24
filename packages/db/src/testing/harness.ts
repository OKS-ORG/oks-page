// Test helper: open a fresh SQLite database and a fresh PostgreSQL schema, both with the
// generated migration applied. PostgreSQL is read from DATABASE_URL. In CI it is required;
// on a developer machine without it, the PostgreSQL runs are skipped.
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { join } from "node:path";
import pg from "pg";
import { migratePg, migrateSqlite } from "../migrate.js";

const root = join(import.meta.dirname, "..", "..", "drizzle");

export type Kind = "sqlite" | "postgres";

/** A time in milliseconds since 1970; the harness converts it for each database. */
export class Ms {
  constructor(public readonly value: number) {}
}
export const ms = (value: number) => new Ms(value);

export interface TestDb {
  kind: Kind;
  /** Run SQL written with `?` placeholders. Returns rows (empty for writes). */
  run(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** A Drizzle client on the same connection. */
  drizzle(schema: Record<string, unknown>): unknown;
  close(): Promise<void>;
}

export const migrationsFolder = (kind: Kind) => join(root, kind === "sqlite" ? "sqlite" : "pg");

export const pgUrl = process.env["DATABASE_URL"];
export const pgAvailable = Boolean(pgUrl);
if (!pgAvailable && process.env["CI"]) throw new Error("DATABASE_URL is required in CI");

const toSqlite = (v: unknown) =>
  v instanceof Ms ? v.value : typeof v === "boolean" ? Number(v) : v;
const toPg = (v: unknown) => (v instanceof Ms ? new Date(v.value) : v);

export async function openSqlite(): Promise<TestDb> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSqlite(db, migrationsFolder("sqlite"));
  return {
    kind: "sqlite",
    async run(sql, params = []) {
      const stmt = db.prepare(sql);
      const p = params.map(toSqlite);
      return (stmt.reader ? stmt.all(...p) : (stmt.run(...p), [])) as Record<string, unknown>[];
    },
    drizzle: (schema) => drizzleSqlite(db, { schema }),
    close: async () => void db.close(),
  };
}

let counter = 0;

export async function openPg(): Promise<TestDb> {
  if (!pgUrl) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: pgUrl });
  await client.connect();
  const schema = `t_${process.pid}_${Date.now()}_${counter++}`;
  await client.query(`create schema "${schema}"`);
  await client.query(`set search_path to "${schema}"`);
  await migratePg(client, migrationsFolder("postgres"), { schema });
  return {
    kind: "postgres",
    async run(sql, params = []) {
      let n = 0;
      const text = sql.replace(/\?/g, () => `$${++n}`);
      const res = await client.query(text, params.map(toPg));
      return res.rows as Record<string, unknown>[];
    },
    drizzle: (s) => drizzlePg(client, { schema: s }),
    async close() {
      await client.query(`drop schema "${schema}" cascade`);
      await client.end();
    },
  };
}

export const openers: { kind: Kind; open: () => Promise<TestDb>; skip: boolean }[] = [
  { kind: "sqlite", open: openSqlite, skip: false },
  { kind: "postgres", open: openPg, skip: !pgAvailable },
];
