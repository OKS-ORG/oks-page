// The one query builder for listing entries, sorted or filtered by a custom field (spec 01, section 4, rule 1).
import { assertKey, fieldExpression, type Dialect, type ValueKind } from "./expression.js";

export interface FieldRef {
  key: string;
  kind: ValueKind;
}

export type Operator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
const SQL_OPERATOR: Record<Operator, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

export interface EntryListOptions {
  siteId: string;
  typeKey: string;
  status?: string | string[];
  filters?: { field: FieldRef; op: Operator; value: string | number | boolean }[];
  sort?: { field: FieldRef; direction?: "asc" | "desc" };
  limit: number;
  offset?: number;
}

export interface BuiltQuery {
  sql: string;
  /** Values for the `?` placeholders, in order. */
  params: unknown[];
}

/** Columns the list returns. Large columns (body, html, revisions) are left out on purpose. */
const LIST_COLUMNS = ["id", "title", "slug", "status", "author_id", "published_at", "updated_at"];

export function buildEntryList(dialect: Dialect, o: EntryListOptions): BuiltQuery {
  assertKey("content type", o.typeKey);
  if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 1000)
    throw new Error("limit must be a whole number from 1 to 1000");
  // The content type is written into the text (it was checked above): a field index is limited to one
  // content type, and a database can only use such an index when the type is a literal, not a parameter.
  const where = [`"site_id" = ?`, `"type_key" = '${o.typeKey}'`];
  const params: unknown[] = [o.siteId];
  const statuses = o.status === undefined ? [] : Array.isArray(o.status) ? o.status : [o.status];
  if (statuses.length) {
    where.push(`"status" in (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  for (const f of o.filters ?? []) {
    where.push(`${fieldExpression(dialect, f.field.key, f.field.kind)} ${SQL_OPERATOR[f.op]} ?`);
    params.push(dialect === "sqlite" && typeof f.value === "boolean" ? Number(f.value) : f.value);
  }
  let sql = `select ${LIST_COLUMNS.map((c) => `"${c}"`).join(", ")} from "entries" where ${where.join(" and ")}`;
  if (o.sort)
    sql += ` order by ${fieldExpression(dialect, o.sort.field.key, o.sort.field.kind)} ${o.sort.direction === "desc" ? "desc" : "asc"}`;
  else sql += ` order by "updated_at" desc`;
  sql += ` limit ${o.limit}`;
  if (o.offset) {
    if (!Number.isInteger(o.offset) || o.offset < 0)
      throw new Error("offset must be a whole number, 0 or more");
    sql += ` offset ${o.offset}`;
  }
  return { sql, params };
}
