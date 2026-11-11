// The site's database connection, made once per process. SQLite (a file) or PostgreSQL (a URL), from the environment.
import { pgRunner, pgSchema, sqliteRunner, sqliteSchema, type SqlRunner } from "@oks-page/db";
import { migratePg, migrateSqlite, migrationsFolder } from "@oks-page/db/migrate";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";

interface Shared {
  runner?: SqlRunner;
  drizzle?: unknown;
  native?: { kind: "sqlite"; db: Database.Database } | { kind: "postgres"; pool: pg.Pool };
  siteId?: string;
}
const shared = globalThis as typeof globalThis & { __oks?: Shared };
const state: Shared = (shared.__oks ??= {});

export function getRunner(): SqlRunner {
  if (state.runner) return state.runner;
  const url = process.env["OKS_DATABASE_URL"];
  if (url) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 10,
      options: process.env["OKS_PG_SEARCH_PATH"]
        ? `-c search_path=${process.env["OKS_PG_SEARCH_PATH"]}`
        : undefined,
    } as pg.PoolConfig);
    state.runner = pgRunner(pool);
    state.native = { kind: "postgres", pool };
    state.drizzle = drizzlePg(pool, { schema: pgSchema });
  } else {
    const file = process.env["OKS_SQLITE_PATH"];
    if (!file) throw new Error("Set OKS_DATABASE_URL (PostgreSQL) or OKS_SQLITE_PATH (SQLite)");
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    state.runner = sqliteRunner(db);
    state.native = { kind: "sqlite", db };
    state.drizzle = drizzleSqlite(db, { schema: sqliteSchema });
  }
  return state.runner;
}

/** The message of the error thrown when setup has not run yet. */
export const NO_SITE = "The database has no site yet";

/**
 * Makes the tables of a new database, or brings an older one up to date. Safe to run at every start: a database that is
 * up to date is left alone, and two servers starting together wait for each other. Returns the migrations it applied.
 */
export async function migrateDatabase(): Promise<string[]> {
  getRunner();
  const native = state.native!;
  if (native.kind === "sqlite") return migrateSqlite(native.db, migrationsFolder("sqlite"));
  const client = await native.pool.connect();
  try {
    const schema = process.env["OKS_PG_SEARCH_PATH"];
    return await migratePg(
      client as unknown as pg.Client,
      migrationsFolder("postgres"),
      schema ? { schema } : {},
    );
  } finally {
    client.release();
  }
}

/** The database as a Drizzle client, for Better Auth. */
export function getDrizzle(): unknown {
  getRunner();
  return state.drizzle;
}

/** The one site of a single-site install. */
export async function getSiteId(): Promise<string> {
  if (state.siteId) return state.siteId;
  const fromEnv = process.env["OKS_SITE_ID"];
  if (fromEnv) return (state.siteId = fromEnv);
  const rows = await getRunner().all(`select "id" from "sites" order by "created_at" limit 1`);
  if (rows.length === 0) throw new Error(NO_SITE);
  return (state.siteId = String(rows[0]!["id"]));
}
