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

/**
 * One connection runs one transaction at a time. Without this, two async callers on the same connection would
 * interleave their statements inside one transaction, and a read-then-write in both could count only once.
 * Calls on the root runner wait for an open transaction; code inside a transaction must use the `tx` it was given.
 */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    idle: () =>
      tail.then(
        () => undefined,
        () => undefined,
      ),
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn, fn);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

export function sqliteRunner(db: Database.Database): SqlRunner {
  const queue = serial();
  const make = (inTransaction: boolean): SqlRunner => {
    const self: SqlRunner = {
      dialect: "sqlite",
      async all(sql, params = []) {
        if (!inTransaction) await queue.idle();
        const stmt = db.prepare(sql);
        const p = params.map(toSqliteValue);
        return (stmt.reader ? stmt.all(...p) : (stmt.run(...p), [])) as Record<string, unknown>[];
      },
      async exec(sql) {
        if (!inTransaction) await queue.idle();
        db.exec(sql);
      },
      transaction(fn) {
        if (inTransaction) return fn(self);
        return queue.run(async () => {
          db.exec("BEGIN IMMEDIATE");
          try {
            const result = await fn(make(true));
            db.exec("COMMIT");
            return result;
          } catch (e) {
            if (db.inTransaction) db.exec("ROLLBACK");
            throw e;
          }
        });
      },
    };
    return self;
  };
  return make(false);
}

/** A PostgreSQL connection that can run one transaction at a time, or a pool (a transaction takes one connection). */
export function pgRunner(source: pg.Client | pg.Pool): SqlRunner {
  const isPool = "totalCount" in source;
  const queue = serial();
  const over = (c: pg.ClientBase | pg.Pool, inTransaction: boolean): SqlRunner => {
    const self: SqlRunner = {
      dialect: "postgres",
      async all(sql, params = []) {
        if (!inTransaction && !isPool) await queue.idle();
        let n = 0;
        const res = await c.query(
          sql.replace(/\?/g, () => `$${++n}`),
          params,
        );
        return res.rows as Record<string, unknown>[];
      },
      async exec(sql) {
        if (!inTransaction && !isPool) await queue.idle();
        await c.query(sql);
      },
      transaction(fn) {
        if (inTransaction) return fn(self);
        const body = async () => {
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
        };
        // A pool gives each transaction its own connection. A single connection takes them one at a time.
        return isPool ? body() : queue.run(body);
      },
    };
    return self;
  };
  return over(source, false);
}
