// Keeps the field indexes equal to the field definitions (spec 01, section 4, rule 5).
//
// The field definitions are the stored truth. The set of `ix_ef_*` indexes is derived from them:
// `syncFieldIndexes` creates the missing ones and drops the extra ones, and does nothing when they match.
// Run it after the migrations at startup, and whenever a field definition changes. A restored backup that
// has the field definitions therefore gets the same indexes again.
import type { SqlRunner } from "../runner.js";
import {
  createFieldIndexSql,
  dropFieldIndexSql,
  FIELD_INDEX_PREFIX,
  fieldIndexName,
  valueKind,
} from "./expression.js";

export interface SyncResult {
  created: string[];
  dropped: string[];
}

export async function syncFieldIndexes(db: SqlRunner): Promise<SyncResult> {
  const defs = await db.all(
    `select ct."site_id" as site_id, ct."key" as type_key, fd."key" as field_key, fd."field_type" as field_type
       from "field_definitions" fd join "content_types" ct on ct."id" = fd."content_type_id"
      where fd."is_sortable" = ${db.dialect === "sqlite" ? "1" : "true"} or fd."is_filterable" = ${db.dialect === "sqlite" ? "1" : "true"}`,
  );
  const wanted = new Map<string, string>();
  for (const d of defs) {
    const kind = valueKind(String(d["field_type"]));
    if (!kind) continue; // not an indexable type: the admin must not offer the flags for it
    const f = {
      siteId: String(d["site_id"]),
      typeKey: String(d["type_key"]),
      key: String(d["field_key"]),
      kind,
    };
    wanted.set(fieldIndexName(f.siteId, f.typeKey, f.key), createFieldIndexSql(db.dialect, f));
  }
  const existing = (
    db.dialect === "sqlite"
      ? await db.all(
          `select name from sqlite_master where type = 'index' and name like '${FIELD_INDEX_PREFIX}%'`,
        )
      : await db.all(
          `select indexname as name from pg_indexes where schemaname = current_schema() and indexname like '${FIELD_INDEX_PREFIX}%'`,
        )
  ).map((r) => String(r["name"]));
  const result: SyncResult = { created: [], dropped: [] };
  for (const name of existing) {
    if (!wanted.has(name)) {
      await db.exec(dropFieldIndexSql(name));
      result.dropped.push(name);
    }
  }
  for (const [name, sql] of wanted) {
    if (!existing.includes(name)) {
      await db.exec(sql);
      result.created.push(name);
    }
  }
  return result;
}
