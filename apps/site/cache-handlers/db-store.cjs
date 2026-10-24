"use strict";
// The store behind the cache handler: the table `cache_tags` in the site's database (SQLite file or PostgreSQL).
// Set OKS_CACHE_SHARED=0 on a single-process install to skip the shared reads altogether.
const RETENTION_MS = 7 * 24 * 3600 * 1000;

function dbStore(env = process.env) {
  if (env.OKS_CACHE_SHARED === "0") return { write: async () => {}, readSince: async () => [] };

  let siteId = env.OKS_SITE_ID;
  let backend;
  const open = () => {
    if (backend) return backend;
    if (env.OKS_DATABASE_URL) {
      const pg = require("pg");
      const pool = new pg.Pool({
        connectionString: env.OKS_DATABASE_URL,
        max: 3,
        ...(env.OKS_PG_SEARCH_PATH ? { options: `-c search_path=${env.OKS_PG_SEARCH_PATH}` } : {}),
      });
      backend = {
        time: (ms) => (ms == null ? null : new Date(ms)),
        ms: (v) => (v == null ? null : v instanceof Date ? v.getTime() : Number(v)),
        run: async (sql, params) => {
          let n = 0;
          return (
            await pool.query(
              sql.replace(/\?/g, () => `$${++n}`),
              params,
            )
          ).rows;
        },
      };
    } else {
      const Database = require("better-sqlite3");
      const db = new Database(env.OKS_SQLITE_PATH);
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      backend = {
        time: (ms) => ms,
        ms: (v) => (v == null ? null : Number(v)),
        run: async (sql, params) => {
          const stmt = db.prepare(sql);
          return stmt.reader ? stmt.all(...params) : (stmt.run(...params), []);
        },
      };
    }
    return backend;
  };
  const site = async () => {
    if (siteId) return siteId;
    const rows = await open().run(`select "id" from "sites" order by "created_at" limit 1`, []);
    if (!rows.length) throw new Error("The database has no site yet");
    return (siteId = String(rows[0].id));
  };

  return {
    async write(tags, { stale, expired }, now) {
      const db = open();
      const id = await site();
      for (const tag of tags) {
        await db.run(
          `insert into "cache_tags" ("site_id", "tag", "stale_at", "expired_at", "updated_at") values (?, ?, ?, ?, ?)
           on conflict ("site_id", "tag") do update set
             "stale_at" = coalesce(excluded."stale_at", "cache_tags"."stale_at"),
             "expired_at" = coalesce(excluded."expired_at", "cache_tags"."expired_at"),
             "updated_at" = excluded."updated_at"`,
          [id, tag, db.time(stale), db.time(expired), db.time(now)],
        );
      }
      // Old events no process can still need (a process that old has an empty cache).
      if (Math.random() < 0.01)
        await db.run(`delete from "cache_tags" where "site_id" = ? and "updated_at" < ?`, [
          id,
          db.time(now - RETENTION_MS),
        ]);
    },
    async readSince(sinceMs) {
      const db = open();
      const id = await site();
      const rows = await db.run(
        `select "tag", "stale_at", "expired_at", "updated_at" from "cache_tags" where "site_id" = ? and "updated_at" >= ?`,
        [id, db.time(sinceMs)],
      );
      return rows.map((r) => ({
        tag: r.tag,
        stale: db.ms(r.stale_at),
        expired: db.ms(r.expired_at),
        updatedAt: db.ms(r.updated_at),
      }));
    },
  };
}

module.exports = { dbStore };
