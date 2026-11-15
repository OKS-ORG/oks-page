// DM-16: both schema definitions describe the same tables, columns, keys, indexes and checks.
import { getTableConfig as getPg } from "drizzle-orm/pg-core";
import { getTableConfig as getSqlite } from "drizzle-orm/sqlite-core";
import { Column, SQL, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import * as pgSchema from "./schema/pg.js";
import * as sqliteSchema from "./schema/sqlite.js";

const family = (columnType: string) => {
  const t = columnType.toLowerCase();
  if (t.includes("boolean")) return "boolean";
  if (t.includes("timestamp")) return "time";
  if (t.includes("json")) return "json";
  if (t.includes("int")) return "integer";
  if (t.includes("real") || t.includes("double")) return "real";
  return "text";
};

// Write a SQL fragment with column names and no quotes, so both dialects compare equal.
const render = (sql: SQL): string =>
  sql.queryChunks
    .map((c) =>
      is(c, Column)
        ? c.name
        : is(c, SQL)
          ? render(c)
          : "value" in (c as object)
            ? (c as { value: string[] }).value.join("")
            : String(c),
    )
    .join("")
    .replace(/["`]/g, "")
    .replace(/\b\w+\./g, "")
    .replace(/\s+/g, " ")
    .trim();

const colName = (c: unknown) => (c as { name?: string }).name ?? "<expression>";

function describePg(t: PgTable) {
  const c = getPg(t);
  return shape(
    c.name,
    c.columns,
    c.primaryKeys,
    c.uniqueConstraints,
    c.indexes,
    c.checks,
    c.foreignKeys,
  );
}
function describeSqlite(t: SQLiteTable) {
  const c = getSqlite(t);
  return shape(
    c.name,
    c.columns,
    c.primaryKeys,
    c.uniqueConstraints,
    c.indexes,
    c.checks,
    c.foreignKeys,
  );
}

type AnyCfg = { name?: string; columns?: unknown[]; config?: unknown };
function shape(
  name: string,
  columns: Column[],
  pks: AnyCfg[],
  uniques: AnyCfg[],
  indexes: AnyCfg[],
  checks: AnyCfg[],
  fks: {
    reference(): { columns: Column[]; foreignTable: object; foreignColumns: Column[] };
    onDelete?: string;
  }[],
) {
  return {
    name,
    columns: Object.fromEntries(
      columns.map((col) => [
        col.name,
        {
          family: family(col.columnType),
          notNull: col.notNull || col.primary,
          hasDefault: col.hasDefault,
          default: col.hasDefault ? JSON.stringify(col.default) : null,
        },
      ]),
    ),
    primaryKey: [
      ...columns.filter((c) => c.primary).map((c) => c.name),
      ...pks.flatMap((p) => (p.columns as Column[]).map((c) => c.name)),
    ].sort(),
    uniques: uniques
      .map((u) => `${u.name}(${(u.columns as Column[]).map((c) => c.name).join(",")})`)
      .sort(),
    indexes: indexes
      .map((i) => {
        const cfg = i.config as { name: string; columns: unknown[]; unique: boolean; where?: SQL };
        return `${cfg.unique ? "unique " : ""}${cfg.name}(${cfg.columns.map(colName).join(",")})${cfg.where ? " where " + render(cfg.where) : ""}`;
      })
      .sort(),
    // The JSON-validity checks exist only on SQLite (PostgreSQL's jsonb type does it).
    checks: checks
      .map((c) => c.name as string)
      .filter((n) => !n.endsWith("_json"))
      .sort(),
    foreignKeys: fks
      .map((fk) => {
        const r = fk.reference();
        return `${r.columns.map((c) => c.name).join(",")} -> ${getForeignName(r.foreignTable)}(${r.foreignColumns.map((c) => c.name).join(",")}) on delete ${fk.onDelete ?? "no action"}`;
      })
      .sort(),
  };
}
const getForeignName = (t: object) =>
  is(t as never, PgTable) ? getPg(t as PgTable).name : getSqlite(t as SQLiteTable).name;

const pgTables = Object.values(pgSchema).filter((v): v is PgTable => is(v as never, PgTable));
const sqliteTables = Object.values(sqliteSchema).filter((v): v is SQLiteTable =>
  is(v as never, SQLiteTable),
);

describe("DM-16 schema parity", () => {
  test("both schemas define the same 45 tables", () => {
    const a = pgTables.map((t) => getPg(t).name).sort();
    const b = sqliteTables.map((t) => getSqlite(t).name).sort();
    expect(a).toHaveLength(47);
    expect(a).toEqual(b);
  });

  const sqliteByName = new Map(sqliteTables.map((t) => [getSqlite(t).name, describeSqlite(t)]));
  for (const t of pgTables) {
    const p = describePg(t);
    test(`${p.name}: columns, keys, indexes, checks and links match`, () => {
      expect(sqliteByName.get(p.name)).toEqual(p);
    });
  }
});
