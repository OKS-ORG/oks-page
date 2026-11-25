// Export and import of a whole database as one JSON document (spec 01, DM-26): the same data can be exported
// from SQLite and imported into PostgreSQL, and back, and gives identical rows.
//
// The dump uses plain JSON values: times are milliseconds since 1970, booleans are true or false, JSON columns are
// objects, and whole numbers are numbers. Rows are sorted by primary key, so two dumps of the same data are equal
// whichever database wrote them. (PostgreSQL's jsonb may order the keys inside an object differently; the data is
// the same. Compare dumps as data, not as text.)
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as pgSchema from "./schema/pg.js";
import type { SqlRunner } from "./runner.js";

type Family = "text" | "boolean" | "time" | "integer" | "real" | "json" | "binary";
interface TableMeta {
  name: string;
  columns: { name: string; family: Family }[];
  primaryKey: string[];
  dependsOn: string[];
  /** A column that points at the same table (a parent), if any. */
  selfParent: string | null;
}

const familyOf = (columnType: string, sqlType = ""): Family => {
  const t = columnType.toLowerCase();
  // A file's bytes (PostgreSQL bytea) travel as base64 text in the dump.
  if (sqlType === "bytea") return "binary";
  if (t.includes("boolean")) return "boolean";
  if (t.includes("timestamp")) return "time";
  if (t.includes("json")) return "json";
  if (t.includes("int")) return "integer";
  if (t.includes("double") || t.includes("real")) return "real";
  return "text";
};

/** Every table with its columns, in an order where a table comes after the tables it points at. */
export function tablesInOrder(): TableMeta[] {
  const metas = (Object.values(pgSchema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t): TableMeta => {
      const c = getTableConfig(t);
      const refs = c.foreignKeys.map((fk) => ({
        table: getTableConfig(fk.reference().foreignTable as PgTable).name,
        column: fk.reference().columns[0]!.name,
      }));
      return {
        name: c.name,
        columns: c.columns.map((col) => ({
          name: col.name,
          family: familyOf(col.columnType, col.getSQLType()),
        })),
        primaryKey: [
          ...c.columns.filter((col) => col.primary).map((col) => col.name),
          ...c.primaryKeys.flatMap((p) => p.columns.map((col) => col.name)),
        ],
        dependsOn: [...new Set(refs.map((r) => r.table).filter((n) => n !== c.name))],
        selfParent: refs.find((r) => r.table === c.name)?.column ?? null,
      };
    });
  const byName = new Map(metas.map((m) => [m.name, m]));
  const ordered: TableMeta[] = [];
  const seen = new Set<string>();
  const visit = (m: TableMeta) => {
    if (seen.has(m.name)) return;
    seen.add(m.name);
    for (const d of m.dependsOn) visit(byName.get(d)!);
    ordered.push(m);
  };
  [...metas].sort((a, b) => a.name.localeCompare(b.name)).forEach(visit);
  return ordered;
}

export interface Dump {
  format: "oks-export";
  version: 1;
  tables: Record<string, Record<string, unknown>[]>;
}

const fromDb = (dialect: SqlRunner["dialect"], family: Family, v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  switch (family) {
    case "time":
      return v instanceof Date ? v.getTime() : Number(v);
    case "boolean":
      return typeof v === "boolean" ? v : Number(v) !== 0;
    case "json":
      // SQLite stores JSON as text. The PostgreSQL driver has already parsed jsonb (a JSON string value arrives as a string).
      return dialect === "sqlite" ? JSON.parse(v as string) : v;
    case "integer":
    case "real":
      return Number(v);
    case "binary":
      return Buffer.from(v as Uint8Array).toString("base64");
    case "text":
      return String(v);
  }
};

const toDb = (dialect: SqlRunner["dialect"], family: Family, v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  switch (family) {
    case "time":
      return dialect === "postgres" ? new Date(v as number) : v;
    case "json":
      return JSON.stringify(v);
    case "binary":
      return Buffer.from(v as string, "base64");
    default:
      return v;
  }
};

const compare = (a: unknown, b: unknown) => (a === b ? 0 : (a as string) < (b as string) ? -1 : 1);

export async function exportData(db: SqlRunner): Promise<Dump> {
  const dump: Dump = { format: "oks-export", version: 1, tables: {} };
  for (const t of tablesInOrder()) {
    const cols = t.columns.map((c) => `"${c.name}"`).join(", ");
    const rows = (await db.all(`select ${cols} from "${t.name}"`)).map((r) =>
      Object.fromEntries(t.columns.map((c) => [c.name, fromDb(db.dialect, c.family, r[c.name])])),
    );
    rows.sort((a, b) => t.primaryKey.reduce((r, k) => r || compare(a[k], b[k]), 0));
    dump.tables[t.name] = rows;
  }
  return dump;
}

/** Rows of a table that points at itself, ordered so a parent is inserted before its children. */
function parentsFirst(
  rows: Record<string, unknown>[],
  parent: string,
  key: string,
): Record<string, unknown>[] {
  const byId = new Map(rows.map((r) => [r[key], r]));
  const depth = (r: Record<string, unknown>, guard = 0): number => {
    if (guard > rows.length) throw new Error("A parent chain loops back on itself");
    const p = r[parent] === null ? undefined : byId.get(r[parent]);
    return p ? 1 + depth(p, guard + 1) : 0;
  };
  return [...rows].sort((a, b) => depth(a) - depth(b));
}

const metaOf = (name: string): TableMeta => {
  const t = tablesInOrder().find((m) => m.name === name);
  if (!t) throw new Error(`There is no table ${name}`);
  return t;
};

/**
 * The rows of one table as plain JSON values (the same form as a whole export), chosen by `where` (SQL after the word
 * "where", with `?` marks for `params`), in primary-key order. For the parts of a database that a site bundle holds.
 */
export async function readRows(
  db: SqlRunner,
  table: string,
  where = "1 = 1",
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const t = metaOf(table);
  const cols = t.columns.map((c) => `"${c.name}"`).join(", ");
  const rows = (await db.all(`select ${cols} from "${t.name}" where ${where}`, params)).map((r) =>
    Object.fromEntries(t.columns.map((c) => [c.name, fromDb(db.dialect, c.family, r[c.name])])),
  );
  rows.sort((a, b) => t.primaryKey.reduce((r, k) => r || compare(a[k], b[k]), 0));
  return rows;
}

/** Inserts rows made by `readRows` (a row that points at its own table has its parent put in first). */
export async function writeRows(
  db: SqlRunner,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const t = metaOf(table);
  const ordered = t.selfParent ? parentsFirst(rows, t.selfParent, t.primaryKey[0]!) : rows;
  const names = t.columns.map((c) => `"${c.name}"`).join(", ");
  const marks = t.columns.map(() => "?").join(", ");
  for (const row of ordered)
    await db.all(
      `insert into "${t.name}" (${names}) values (${marks})`,
      t.columns.map((c) => toDb(db.dialect, c.family, row[c.name])),
    );
}

/** The column names of a table, in order (to check a bundle's rows have the right shape). */
export const columnsOf = (table: string): string[] => metaOf(table).columns.map((c) => c.name);

export async function importData(db: SqlRunner, dump: Dump): Promise<{ rows: number }> {
  if (dump.format !== "oks-export" || dump.version !== 1)
    throw new Error("This is not an oks export, or its version is not supported");
  const tables = tablesInOrder();
  const unknown = Object.keys(dump.tables).filter((n) => !tables.some((t) => t.name === n));
  if (unknown.length)
    throw new Error(`The export has tables this version does not know: ${unknown.join(", ")}`);
  return db.transaction(async (tx) => {
    for (const t of tables) {
      const existing = await tx.all(`select count(*) as c from "${t.name}"`);
      if (Number(existing[0]!["c"]) > 0)
        throw new Error(`The target database is not empty (table ${t.name})`);
    }
    let total = 0;
    for (const t of tables) {
      let rows = dump.tables[t.name] ?? [];
      if (t.selfParent) rows = parentsFirst(rows, t.selfParent, t.primaryKey[0]!);
      const names = t.columns.map((c) => `"${c.name}"`).join(", ");
      const marks = t.columns.map(() => "?").join(", ");
      for (const row of rows) {
        await tx.all(
          `insert into "${t.name}" (${names}) values (${marks})`,
          t.columns.map((c) => toDb(tx.dialect, c.family, row[c.name])),
        );
        total++;
      }
    }
    return { rows: total };
  });
}
