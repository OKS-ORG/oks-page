// A small, database-neutral way to run SQL, used by the save rule, the export and import, and the sync of field
// indexes. Placeholders are written as `?` for both databases.
import type Database from "better-sqlite3";
import type pg from "pg";
import type { Dialect } from "./fields/expression.js";

export interface SqlRunner {
  dialect: Dialect;
  /** Run one statement and return its rows (empty for statements that return none). */
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Run one statement that takes no parameters. */
  exec(sql: string): Promise<void>;
  /** Run `fn` in one transaction: everything is saved together, or nothing is. */
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

const toSqliteValue = (v: unknown) =>
  typeof v === "boolean" ? Number(v) : v instanceof Date ? v.getTime() : v;

export function sqliteRunner(db: Database.Database): SqlRunner {
  const self: SqlRunner = {
    dialect: "sqlite",
    async all(sql, params = []) {
      const stmt = db.prepare(sql);
      const p = params.map(toSqliteValue);
      return (stmt.reader ? stmt.all(...p) : (stmt.run(...p), [])) as Record<string, unknown>[];
    },
    async exec(sql) {
      db.exec(sql);
    },
    async transaction(fn) {
      // A transaction already open (a nested call) is joined, not restarted.
      if (db.inTransaction) return fn(self);
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(self);
        db.exec("COMMIT");
        return result;
      } catch (e) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return self;
}

/** A PostgreSQL connection that can run one transaction at a time, or a pool (a transaction takes one connection). */
export function pgRunner(source: pg.Client | pg.Pool): SqlRunner {
  const isPool = "totalCount" in source;
  const over = (c: pg.ClientBase | pg.Pool, inTransaction: boolean): SqlRunner => {
    const self: SqlRunner = {
      dialect: "postgres",
      async all(sql, params = []) {
        let n = 0;
        const res = await c.query(
          sql.replace(/\?/g, () => `$${++n}`),
          params,
        );
        return res.rows as Record<string, unknown>[];
      },
      async exec(sql) {
        await c.query(sql);
      },
      async transaction(fn) {
        if (inTransaction) return fn(self);
        const client = isPool ? await (c as pg.Pool).connect() : (c as pg.Client);
        try {
          await client.query("begin");
          try {
            const result = await fn(over(client, true));
            await client.query("commit");
            return result;
          } catch (e) {
            await client.query("rollback");
            throw e;
          }
        } finally {
          if (isPool) (client as pg.PoolClient).release();
        }
      },
    };
    return self;
  };
  return over(source, false);
}
