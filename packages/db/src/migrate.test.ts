// DM-20 (migrations run once when two servers start together) and DM-21 (a fresh install and an
// upgrade end with the same schema), on SQLite and PostgreSQL.
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, test } from "vitest";
import { migratePg, migrateSqlite, readMigrations } from "./migrate.js";
import { pgAvailable, pgUrl } from "./testing/harness.js";

const real = (kind: "sqlite" | "pg") => join(import.meta.dirname, "..", "drizzle", kind);
const realTags = (kind: "sqlite" | "pg") => readMigrations(real(kind)).map((m) => m.tag);
const noteTag = (kind: "sqlite" | "pg") => `${String(realTags(kind).length).padStart(4, "0")}_note`;
const allTags = (kind: "sqlite" | "pg") => [...realTags(kind), noteTag(kind)];

/** A copy of the real migrations plus a second one that adds a column, as a later release would. */
function withSecondMigration(kind: "sqlite" | "pg", extra = true): string {
  const dir = mkdtempSync(join(tmpdir(), "oks-mig-"));
  cpSync(real(kind), dir, { recursive: true });
  if (extra) {
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    const idx = journal.entries.length;
    journal.entries.push({
      idx,
      version: journal.entries[0].version,
      when: Date.now(),
      tag: `${String(idx).padStart(4, "0")}_note`,
      breakpoints: true,
    });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(
      join(dir, `${noteTag(kind)}.sql`),
      kind === "sqlite"
        ? "ALTER TABLE `sites` ADD `note` text;"
        : 'ALTER TABLE "sites" ADD COLUMN "note" text;',
    );
  }
  return dir;
}

const sqliteShape = (db: Database.Database) =>
  db
    .prepare(
      "select type, name, tbl_name, sql from sqlite_master where name not like 'sqlite_%' and name <> 'oks_migrations' order by type, name",
    )
    .all()
    .map((r) => JSON.stringify(r));

describe("sqlite migrations", () => {
  const files: Database.Database[] = [];
  const open = (path = ":memory:") => {
    const db = new Database(path);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 30000");
    files.push(db);
    return db;
  };
  afterEach(() => files.splice(0).forEach((d) => d.open && d.close()));

  test("a fresh install applies every migration and records it", () => {
    const db = open();
    const dir = withSecondMigration("sqlite");
    expect(migrateSqlite(db, dir)).toEqual(allTags("sqlite"));
    expect(db.prepare("select count(*) c from oks_migrations").get()).toEqual({
      c: allTags("sqlite").length,
    });
    expect(migrateSqlite(db, dir)).toEqual([]);
  });

  test("DM-21 an upgrade from the previous version ends with the same schema as a fresh install", () => {
    const dir = withSecondMigration("sqlite");
    const upgraded = open();
    migrateSqlite(upgraded, dir, { upTo: realTags("sqlite").length });
    const before = sqliteShape(upgraded);
    migrateSqlite(upgraded, dir);
    expect(sqliteShape(upgraded)).not.toEqual(before);
    const fresh = open();
    migrateSqlite(fresh, dir);
    expect(sqliteShape(upgraded)).toEqual(sqliteShape(fresh));
  });

  test("0004 keeps the layout changes stored before it (the SQLite table is rebuilt)", () => {
    const db = open();
    const tags = realTags("sqlite");
    const at = tags.indexOf("0004_theme_layout_changes");
    expect(at).toBeGreaterThan(0);
    migrateSqlite(db, real("sqlite"), { upTo: at });
    const site = "1".repeat(26);
    const theme = "0".repeat(26);
    db.prepare("insert into sites (id, name, created_at, updated_at) values (?, ?, 1, 1)").run(
      site,
      "S",
    );
    db.prepare(
      "insert into themes (id, site_id, key, version, source, is_active, settings) values (?, ?, 'maple', '1.0.0', 'runtime', 1, '{}')",
    ).run(theme, site);
    db.prepare(
      "insert into theme_overrides (theme_id, template_key, content, base_hash, base_version, updated_at) values (?, ?, ?, ?, ?, ?)",
    ).run(theme, "templates/index", '{"blocks":[]}', "abc", "1.0.0", 1);
    migrateSqlite(db, real("sqlite"));
    expect(db.prepare("select * from theme_overrides").all()).toEqual([
      {
        theme_id: theme,
        template_key: "templates/index",
        content: '{"blocks":[]}',
        draft: null,
        kind: "theme",
        name: "",
        base_hash: "abc",
        base_version: "1.0.0",
        updated_at: 1,
      },
    ]);
  });

  test("a migration that was changed after it was applied is refused", () => {
    const db = open();
    const dir = withSecondMigration("sqlite", false);
    migrateSqlite(db, dir);
    writeFileSync(
      join(dir, "0000_init.sql"),
      readFileSync(join(dir, "0000_init.sql"), "utf8") + "\n-- edited",
    );
    expect(() => migrateSqlite(db, dir)).toThrow(/changed after it was applied/);
  });

  test("a database that is newer than the code is refused", () => {
    const db = open();
    migrateSqlite(db, withSecondMigration("sqlite"));
    expect(() => migrateSqlite(db, withSecondMigration("sqlite", false))).toThrow(
      /newer than the code/,
    );
  });

  test("a failing migration leaves nothing behind", () => {
    const db = open();
    const dir = withSecondMigration("sqlite");
    writeFileSync(
      join(dir, `${noteTag("sqlite")}.sql`),
      "ALTER TABLE `sites` ADD `note` text;--> statement-breakpoint\nthis is not sql;",
    );
    expect(() => migrateSqlite(db, dir)).toThrow();
    // Everything rolled back: not even the records table or the first migration's tables remain.
    expect(
      db
        .prepare("select count(*) c from sqlite_master where name in ('sites', 'oks_migrations')")
        .get(),
    ).toEqual({ c: 0 });
  });

  test("DM-20 a second process waits for the first and then migrates nothing", async () => {
    const dir = withSecondMigration("sqlite");
    const file = join(mkdtempSync(join(tmpdir(), "oks-lock-")), "lock.sqlite");
    // This connection holds the write lock, as a first server in the middle of migrating would.
    const holder = open(file);
    holder.exec("BEGIN IMMEDIATE");
    const worker = join(import.meta.dirname, "testing", "migrate-worker.mjs");
    const child = spawn(process.execPath, [worker, file, dir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    let exited = false;
    const done = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => ((exited = true), resolve(code))),
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(exited, "the second process must wait while the first holds the lock").toBe(false);
    holder.exec("COMMIT");
    expect(await done, err).toBe(0);
    expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual(allTags("sqlite"));
    expect(holder.prepare("select count(*) c from oks_migrations").get()).toEqual({
      c: allTags("sqlite").length,
    });
  });

  test("DM-20 several processes started together migrate once", async () => {
    const dir = withSecondMigration("sqlite");
    const file = join(mkdtempSync(join(tmpdir(), "oks-many-")), "many.sqlite");
    const worker = join(import.meta.dirname, "testing", "migrate-worker.mjs");
    const run = () =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const c = spawn(process.execPath, [worker, file, dir], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (err += d));
        c.on("exit", (code) => resolve({ code, out, err }));
      });
    const results = await Promise.all([run(), run(), run(), run(), run()]);
    for (const r of results) expect(r.code, r.err).toBe(0);
    const applied = results.map((r) => JSON.parse(r.out.trim().split("\n").pop()!) as string[]);
    expect(applied.filter((a) => a.length > 0)).toHaveLength(1);
    const check = open(file);
    expect(check.prepare("select count(*) c from oks_migrations").get()).toEqual({
      c: allTags("sqlite").length,
    });
  });

  test("the real migrations match what the journal lists", () => {
    expect(readMigrations(real("sqlite")).map((m) => m.tag)).toEqual([
      "0000_init",
      "0001_cache_tags",
      "0002_extension_updates_and_rollback",
      "0003_extension_settings",
      "0004_theme_layout_changes",
      "0005_saved_sections",
      "0006_email_log",
      "0007_email_texts",
      "0008_search_terms",
      "0009_search_index",
    ]);
  });
});

describe.skipIf(!pgAvailable)("postgres migrations", () => {
  const clients: pg.Client[] = [];
  const schemas: string[] = [];
  let n = 0;
  async function client() {
    const c = new pg.Client({ connectionString: pgUrl });
    await c.connect();
    clients.push(c);
    return c;
  }
  async function freshSchema() {
    const admin = await client();
    const schema = `m_${process.pid}_${Date.now()}_${n++}`;
    await admin.query(`create schema "${schema}"`);
    schemas.push(schema);
    return schema;
  }
  afterEach(async () => {
    const admin = new pg.Client({ connectionString: pgUrl });
    await admin.connect();
    for (const s of schemas.splice(0)) await admin.query(`drop schema if exists "${s}" cascade`);
    await admin.end();
    await Promise.all(clients.splice(0).map((c) => c.end()));
  });

  const shape = async (c: pg.Client, schema: string) => {
    const q = async (text: string) =>
      (await c.query(text, [schema])).rows.map((r) => JSON.stringify(r));
    return {
      columns: await q(
        "select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = $1 and table_name <> 'oks_migrations' order by 1, 2",
      ),
      indexes: await q(
        "select tablename, indexname, indexdef from pg_indexes where schemaname = $1 and tablename <> 'oks_migrations' order by 1, 2",
      ),
      constraints: await q(
        "select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = $1::regnamespace and conrelid::regclass::text <> 'oks_migrations' order by 1, 2",
      ),
    };
  };

  test("a fresh install applies every migration and records it", async () => {
    const schema = await freshSchema();
    const c = await client();
    const dir = withSecondMigration("pg");
    expect(await migratePg(c, dir, { schema })).toEqual(allTags("pg"));
    expect(
      (await c.query(`select count(*)::int c from "${schema}".oks_migrations`)).rows[0].c,
    ).toBe(allTags("pg").length);
    expect(await migratePg(c, dir, { schema })).toEqual([]);
  });

  test("DM-21 an upgrade from the previous version ends with the same schema as a fresh install", async () => {
    const dir = withSecondMigration("pg");
    const a = await freshSchema();
    const b = await freshSchema();
    const c = await client();
    await migratePg(c, dir, { schema: a, upTo: realTags("pg").length });
    await migratePg(c, dir, { schema: a });
    await migratePg(c, dir, { schema: b });
    const normalise = (s: string[]) => s.map((x) => x.replaceAll(a, "S").replaceAll(b, "S"));
    const [sa, sb] = [await shape(c, a), await shape(c, b)];
    expect(normalise(sa.columns)).toEqual(normalise(sb.columns));
    expect(normalise(sa.indexes)).toEqual(normalise(sb.indexes));
    expect(normalise(sa.constraints)).toEqual(normalise(sb.constraints));
    expect(sa.columns.some((x) => x.includes('"note"'))).toBe(true);
  });

  test("a migration that was changed after it was applied is refused", async () => {
    const schema = await freshSchema();
    const c = await client();
    const dir = withSecondMigration("pg", false);
    await migratePg(c, dir, { schema });
    writeFileSync(
      join(dir, "0000_init.sql"),
      readFileSync(join(dir, "0000_init.sql"), "utf8") + "\n-- edited",
    );
    await expect(migratePg(c, dir, { schema })).rejects.toThrow(/changed after it was applied/);
  });

  test("a failing migration leaves nothing behind", async () => {
    const schema = await freshSchema();
    const c = await client();
    const dir = withSecondMigration("pg");
    writeFileSync(
      join(dir, `${noteTag("pg")}.sql`),
      'ALTER TABLE "sites" ADD COLUMN "note" text;--> statement-breakpoint\nthis is not sql;',
    );
    await expect(migratePg(c, dir, { schema })).rejects.toThrow();
    expect(
      (
        await c.query(
          `select count(*)::int c from information_schema.tables where table_schema = $1 and table_name = 'sites'`,
          [schema],
        )
      ).rows[0].c,
    ).toBe(0);
  });

  test("DM-20 a second server waits while the first holds the lock, then migrates nothing", async () => {
    const schema = await freshSchema();
    const holder = await client();
    const second = await client();
    const dir = withSecondMigration("pg");
    await holder.query("select pg_advisory_lock(7203104551)");
    let finished = false;
    const run = migratePg(second, dir, { schema }).then((r) => ((finished = true), r));
    await new Promise((r) => setTimeout(r, 800));
    expect(finished, "the second server must wait for the lock").toBe(false);
    await holder.query("select pg_advisory_unlock(7203104551)");
    expect(await run).toEqual(allTags("pg"));
  });

  test("DM-20 several servers started together migrate once", async () => {
    const schema = await freshSchema();
    const dir = withSecondMigration("pg");
    const cs = await Promise.all([client(), client(), client(), client(), client()]);
    const results = await Promise.all(cs.map((c) => migratePg(c, dir, { schema })));
    expect(results.filter((r) => r.length > 0)).toHaveLength(1);
    expect(
      (await cs[0]!.query(`select count(*)::int c from "${schema}".oks_migrations`)).rows[0].c,
    ).toBe(allTags("pg").length);
  });

  test("the real migrations match what the journal lists", () => {
    expect(readMigrations(real("pg")).map((m) => m.tag)).toEqual([
      "0000_init",
      "0001_cache_tags",
      "0002_extension_updates_and_rollback",
      "0003_extension_settings",
      "0004_theme_layout_changes",
      "0005_saved_sections",
      "0006_email_log",
      "0007_email_texts",
      "0008_search_terms",
      "0009_search_index",
    ]);
  });
});
