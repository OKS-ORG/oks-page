// The site's database connection, made once per process. SQLite (a file) or PostgreSQL (a URL), from the environment.
import { pgRunner, sqliteRunner, type SqlRunner } from "@oks-page/db";
import Database from "better-sqlite3";
import pg from "pg";

interface Shared {
  runner?: SqlRunner;
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
  } else {
    const file = process.env["OKS_SQLITE_PATH"];
    if (!file) throw new Error("Set OKS_DATABASE_URL (PostgreSQL) or OKS_SQLITE_PATH (SQLite)");
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    state.runner = sqliteRunner(db);
  }
  return state.runner;
}

/** The one site of a single-site install. */
export async function getSiteId(): Promise<string> {
  if (state.siteId) return state.siteId;
  const fromEnv = process.env["OKS_SITE_ID"];
  if (fromEnv) return (state.siteId = fromEnv);
  const rows = await getRunner().all(`select "id" from "sites" order by "created_at" limit 1`);
  if (rows.length === 0) throw new Error("The database has no site yet");
  return (state.siteId = String(rows[0]!["id"]));
}
