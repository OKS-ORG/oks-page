// Custom field values live in `entries.fields` (JSON). Spec 01, section 4: one index per content type and
// sortable or filterable field, and ONE function that writes the expression, so a query and its index
// always match. If a query writes the expression differently (another cast or JSON operator), the
// database ignores the index and scans every entry (tested: DM-17, and the control in the S0 seed tests).
import { createHash } from "node:crypto";

export type Dialect = "sqlite" | "postgres";

/** How a field's value is compared. The field type fixes it (spec 01, section 4, rule 4). */
export type ValueKind = "text" | "number" | "boolean";

// Field types of spec 03 section 8 that can be indexed. The others (rich text, multi-select, date range,
// media, repeater, JSON) are not scalar values, so they cannot be sorted or filtered by an index.
const KIND_BY_FIELD_TYPE: Record<string, ValueKind> = {
  text: "text",
  "long text": "text",
  select: "text",
  radio: "text",
  date: "text", // ISO text sorts in date order
  "date and time": "text",
  phone: "text",
  email: "text",
  url: "text",
  color: "text",
  relation: "text", // the id of the related entry
  number: "number",
  range: "number",
  "true / false": "boolean",
};

export function valueKind(fieldType: string): ValueKind | null {
  return KIND_BY_FIELD_TYPE[fieldType] ?? null;
}

const KEY = /^[a-z][a-z0-9_]{0,63}$/;
/** Field and content type keys go into index definitions, which cannot use parameters, so they are checked. */
export function assertKey(kind: "field" | "content type", key: string): void {
  if (!KEY.test(key))
    throw new Error(
      `Invalid ${kind} key "${key}": use lower-case letters, digits and underscores, starting with a letter (64 characters at most)`,
    );
}

/** The expression that reads one custom field from `entries.fields`. The only place that writes it. */
export function fieldExpression(dialect: Dialect, key: string, kind: ValueKind): string {
  assertKey("field", key);
  if (dialect === "sqlite") {
    // `->>` gives SQL text, integer or real, so numbers compare as numbers and true / false as 1 / 0.
    return `("fields" ->> '$.${key}')`;
  }
  switch (kind) {
    case "number":
      return `(("fields" ->> '${key}')::numeric)`;
    case "boolean":
      return `(("fields" ->> '${key}')::boolean)`;
    case "text":
      return `("fields" ->> '${key}')`;
  }
}

/** Generated index name, unique per site, type and field (spec 01, section 4, rule 6). */
export function fieldIndexName(siteId: string, typeKey: string, key: string): string {
  return `ix_ef_${createHash("sha256").update(`${siteId}\0${typeKey}\0${key}`).digest("hex").slice(0, 16)}`;
}
export const FIELD_INDEX_PREFIX = "ix_ef_";

export interface FieldIndex {
  siteId: string;
  typeKey: string;
  key: string;
  kind: ValueKind;
}

export function createFieldIndexSql(dialect: Dialect, f: FieldIndex): string {
  assertKey("content type", f.typeKey);
  const name = fieldIndexName(f.siteId, f.typeKey, f.key);
  // The index is limited to the content type only, not to the status (rule 2), and starts with site_id (rule 3).
  return `create index if not exists "${name}" on "entries" ("site_id", ${fieldExpression(dialect, f.key, f.kind)}) where "type_key" = '${f.typeKey}'`;
}

export function dropFieldIndexSql(name: string): string {
  if (!/^ix_ef_[0-9a-f]{16}$/.test(name)) throw new Error(`Not a field index name: ${name}`);
  return `drop index if exists "${name}"`;
}
