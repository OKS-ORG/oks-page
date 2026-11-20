// Content types and their fields, made from the admin (spec 01, "content_types" and "field_definitions"; spec 03).
// Page and Post are built in: they cannot be changed or deleted here. Any other type has a key, a name, an address
// prefix, a choice whether it has a page body, and a list of fields. A field marked sortable or filterable gets an
// index (DM-18), which is kept in step by `syncFieldIndexes` after every change.
import { fields as dbFields, newId, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

/** The field types the admin offers. Each one is a scalar the index code knows (`valueKind`). */
export const FIELD_TYPES = [
  "text",
  "long text",
  "number",
  "true / false",
  "date",
  "picture",
  "relation",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const BUILT_IN_KEYS = ["page", "post"];

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  sortable: boolean;
  filterable: boolean;
  /** For a "relation" field: the key of the type whose entries it links to. */
  target?: string;
}

export interface ContentTypeInfo {
  key: string;
  label: string;
  /** What comes before the slug in the address: "" or "docs/". */
  urlPrefix: string;
  hasBody: boolean;
  builtIn: boolean;
  fields: FieldDef[];
  entryCount: number;
}

export type TypeResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string; field?: string };

const fail = (
  code: "forbidden" | "invalid" | "not_found",
  message: string,
  field?: string,
): { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string; field?: string } => ({
  ok: false,
  code,
  message,
  ...(field ? { field } : {}),
});

const parse = (value: unknown): Record<string, unknown> => {
  const v = typeof value === "string" ? JSON.parse(value) : value;
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
};

/** "/docs/{slug}" gives "docs/"; "/{slug}" gives "". */
const prefixOf = (rule: string): string => {
  const m = /^\/((?:[a-z0-9-]+\/)*)\{slug\}$/.exec(rule);
  return m ? m[1]! : "";
};

export async function listContentTypes(
  runner: SqlRunner,
  siteId: string,
): Promise<ContentTypeInfo[]> {
  const types = await runner.all(
    `select "id", "key", "label", "url_rule", "has_body" from "content_types" where "site_id" = ? order by "label"`,
    [siteId],
  );
  const counts = new Map<string, number>();
  for (const r of await runner.all(
    `select "type_key", count(*) as n from "entries" where "site_id" = ? and "status" <> 'trash' group by "type_key"`,
    [siteId],
  ))
    counts.set(String(r["type_key"]), Number(r["n"]));
  const result: ContentTypeInfo[] = [];
  for (const t of types) {
    const defs = await runner.all(
      `select "key", "label", "field_type", "validation", "options", "is_sortable", "is_filterable" from "field_definitions"
        where "content_type_id" = ? order by "position", "key"`,
      [String(t["id"])],
    );
    const key = String(t["key"]);
    result.push({
      key,
      label: String(t["label"]),
      urlPrefix: prefixOf(String(t["url_rule"])),
      hasBody: t["has_body"] === true || t["has_body"] === 1 || t["has_body"] === "1",
      builtIn: BUILT_IN_KEYS.includes(key),
      entryCount: counts.get(key) ?? 0,
      fields: defs.map((d) => ({
        key: String(d["key"]),
        label: String(d["label"]),
        type: String(d["field_type"]) as FieldType,
        required: parse(d["validation"])["required"] === true,
        ...(String(d["field_type"]) === "relation"
          ? { target: String(parse(d["options"])["target"] ?? "") }
          : {}),
        sortable: d["is_sortable"] === true || d["is_sortable"] === 1 || d["is_sortable"] === "1",
        filterable:
          d["is_filterable"] === true || d["is_filterable"] === 1 || d["is_filterable"] === "1",
      })),
    });
  }
  return result;
}

const KEY = /^[a-z][a-z0-9_]{0,63}$/;
const URL_PREFIX = /^(?:[a-z0-9-]+\/)*$/;
/** Addresses the site keeps for itself cannot start a type's address prefix. */
const RESERVED_PREFIX = new Set([
  "admin",
  "api",
  "_next",
  "preview",
  "search",
  "feed",
  "fonts",
  "category",
  "tag",
  "page",
  "home",
]);

export interface ContentTypeInput {
  key: string;
  label: string;
  urlPrefix?: string;
  hasBody?: boolean;
  fields?: {
    key: string;
    label: string;
    type: string;
    required?: boolean;
    sortable?: boolean;
    filterable?: boolean;
    target?: string;
  }[];
}

/** Makes a content type, or changes the one with this key. The key cannot change; Page and Post cannot be touched. */
export async function saveContentType(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: ContentTypeInput,
  now: () => number = Date.now,
): Promise<TypeResult<{ type: ContentTypeInfo }>> {
  if (!actor.can("content_types.manage"))
    return fail("forbidden", "You may not change content types.");
  const key = String(input.key ?? "").trim();
  if (!KEY.test(key))
    return fail(
      "invalid",
      "The key can only have lower-case letters, numbers and underscores, and must start with a letter.",
      "key",
    );
  if (BUILT_IN_KEYS.includes(key))
    return fail("invalid", "Page and Post are built in and cannot be changed here.", "key");
  const label = String(input.label ?? "").trim();
  if (!label || label.length > 80)
    return fail("invalid", "Give it a name of at most 80 characters.", "label");
  const prefix = String(input.urlPrefix ?? "").trim();
  if (!URL_PREFIX.test(prefix) || prefix.length > 80)
    return fail(
      "invalid",
      'The address prefix is like "docs/" or "docs/guides/": lower-case letters, numbers and hyphens, each part followed by a slash.',
      "urlPrefix",
    );
  if (RESERVED_PREFIX.has(prefix.split("/")[0]!))
    return fail("invalid", "This address is kept for the site itself.", "urlPrefix");
  const rawFields = input.fields ?? [];
  if (rawFields.length > 40) return fail("invalid", "A type can have at most 40 fields.", "fields");
  const seen = new Set<string>();
  const defs: FieldDef[] = [];
  for (const f of rawFields) {
    const fkey = String(f.key ?? "").trim();
    if (!KEY.test(fkey))
      return fail(
        "invalid",
        `The field key "${fkey}" can only have lower-case letters, numbers and underscores, and must start with a letter.`,
        "fields",
      );
    if (seen.has(fkey)) return fail("invalid", `The field key "${fkey}" is used twice.`, "fields");
    seen.add(fkey);
    const flabel = String(f.label ?? "").trim();
    if (!flabel || flabel.length > 80)
      return fail("invalid", `Give the field "${fkey}" a name of at most 80 characters.`, "fields");
    if (!(FIELD_TYPES as readonly string[]).includes(f.type))
      return fail("invalid", `The field "${fkey}" has an unknown type.`, "fields");
    const type = f.type as FieldType;
    // Only a single value can be sorted or searched by an index; a long text and a picture cannot, and the id of a
    // linked entry has no order worth sorting by (it can be searched by).
    const indexable = type !== "long text" && type !== "picture";
    const target = String(f.target ?? "").trim();
    if (type === "relation" && !KEY.test(target))
      return fail("invalid", `Choose the type the field "${fkey}" links to.`, "fields");
    defs.push({
      key: fkey,
      label: flabel,
      type,
      required: f.required === true,
      sortable: indexable && type !== "relation" && f.sortable === true,
      filterable: indexable && f.filterable === true,
      ...(type === "relation" ? { target } : {}),
    });
  }
  // A link goes to a type that exists (or to the type being made).
  for (const d of defs)
    if (d.type === "relation" && d.target !== key) {
      const found = await runner.all(
        `select "id" from "content_types" where "site_id" = ? and "key" = ?`,
        [siteId, d.target],
      );
      if (found.length === 0)
        return fail("invalid", `The type "${d.target}" does not exist.`, "fields");
    }
  const at = new Date(now());
  const rule = `/${prefix}{slug}`;
  const hasBody = input.hasBody !== false;
  let typeId = (
    await runner.all(`select "id" from "content_types" where "site_id" = ? and "key" = ?`, [
      siteId,
      key,
    ])
  )[0]?.["id"] as string | undefined;
  // A prefix is only changed while no entry uses the type: its entries keep the old prefix in their address.
  if (typeId) {
    const current = (
      await runner.all(`select "url_rule" from "content_types" where "id" = ?`, [typeId])
    )[0]!;
    const used = await runner.all(
      `select "id" from "entries" where "site_id" = ? and "type_key" = ? limit 1`,
      [siteId, key],
    );
    if (String(current["url_rule"]) !== rule && used.length > 0)
      return fail(
        "invalid",
        "The address prefix cannot change while the type has entries (also in the trash).",
        "urlPrefix",
      );
    await runner.all(
      `update "content_types" set "label" = ?, "url_rule" = ?, "has_body" = ?, "updated_at" = ? where "id" = ?`,
      [label, rule, hasBody, at, typeId],
    );
    await runner.all(`delete from "field_definitions" where "content_type_id" = ?`, [typeId]);
  } else {
    typeId = newId();
    await runner.all(
      `insert into "content_types" ("id", "site_id", "key", "label", "url_rule", "has_body", "hierarchical", "options", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [typeId, siteId, key, label, rule, hasBody, false, "{}", at, at],
    );
  }
  let position = 0;
  for (const d of defs)
    await runner.all(
      `insert into "field_definitions" ("id", "content_type_id", "key", "label", "field_type", "validation", "options", "is_sortable", "is_filterable", "position") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        typeId,
        d.key,
        d.label,
        d.type,
        JSON.stringify(d.required ? { required: true } : {}),
        JSON.stringify(d.type === "relation" ? { target: d.target } : {}),
        d.sortable,
        d.filterable,
        position++,
      ],
    );
  await dbFields.syncFieldIndexes(runner);
  const type = (await listContentTypes(runner, siteId)).find((t) => t.key === key)!;
  return { ok: true, type };
}

/** Deletes a type that has no entries at all (the trash counts). Page and Post cannot be deleted. */
export async function deleteContentType(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  key: string,
): Promise<TypeResult<object>> {
  if (!actor.can("content_types.manage"))
    return fail("forbidden", "You may not change content types.");
  if (BUILT_IN_KEYS.includes(key))
    return fail("invalid", "Page and Post are built in and cannot be deleted.");
  const row = (
    await runner.all(`select "id" from "content_types" where "site_id" = ? and "key" = ?`, [
      siteId,
      key,
    ])
  )[0];
  if (!row) return fail("not_found", "This type does not exist.");
  const used = await runner.all(
    `select "id" from "entries" where "site_id" = ? and "type_key" = ? limit 1`,
    [siteId, key],
  );
  if (used.length > 0)
    return fail("invalid", "Delete or move its entries first (the trash counts too).");
  await runner.all(`delete from "content_types" where "id" = ?`, [String(row["id"])]);
  await dbFields.syncFieldIndexes(runner);
  return { ok: true };
}

/**
 * Checks the values of an entry against the fields of its type and returns the cleaned `fields` object: unknown keys
 * are dropped, a number comes as a number, true / false as a boolean, a date as "YYYY-MM-DD". An empty value is left out.
 */
export function cleanFieldValues(
  defs: FieldDef[],
  input: unknown,
): { ok: true; fields: Record<string, unknown> } | { ok: false; message: string; field: string } {
  const given =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const raw = given[d.key];
    const empty = raw === undefined || raw === null || raw === "";
    if (d.type === "true / false") {
      out[d.key] = raw === true || raw === "true";
      continue;
    }
    if (empty) {
      if (d.required) return { ok: false, message: `Fill in "${d.label}".`, field: d.key };
      continue;
    }
    if (d.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw));
      if (!Number.isFinite(n))
        return { ok: false, message: `"${d.label}" must be a number.`, field: d.key };
      out[d.key] = n;
    } else if (d.type === "relation") {
      // The id of the entry it links to (checked against the site's entries when the entry is saved).
      const s = String(raw);
      if (!/^[0-9A-Za-z]{26}$/.test(s))
        return { ok: false, message: `"${d.label}" must be an entry.`, field: d.key };
      out[d.key] = s;
    } else if (d.type === "picture") {
      // The id of a file in the library (it is checked against the library when the entry is saved).
      const s = String(raw);
      if (!/^[0-9A-Za-z]{26}$/.test(s))
        return {
          ok: false,
          message: `"${d.label}" must be a picture from the library.`,
          field: d.key,
        };
      out[d.key] = s;
    } else if (d.type === "date") {
      const s = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)))
        return { ok: false, message: `"${d.label}" must be a date.`, field: d.key };
      out[d.key] = s;
    } else {
      const s = String(raw);
      if (s.length > (d.type === "text" ? 500 : 20_000))
        return { ok: false, message: `"${d.label}" is too long.`, field: d.key };
      out[d.key] = s;
    }
  }
  return { ok: true, fields: out };
}

/**
 * The library files the picture fields of an entry point to, as the rows that say which files a page uses (so a file in
 * use is not deleted by mistake). With `strict` a value that is not an image in this site's library is refused with the
 * field named; without it (values that were saved earlier and are not being changed) such a value is just left out.
 */
export async function pictureMedia(
  runner: SqlRunner,
  siteId: string,
  defs: FieldDef[],
  values: Record<string, unknown>,
  strict: boolean,
): Promise<
  | { ok: true; media: { mediaId: string; field: string }[] }
  | { ok: false; message: string; field: string }
> {
  const wanted = defs
    .filter((d) => d.type === "picture" && typeof values[d.key] === "string")
    .map((d) => ({ def: d, id: values[d.key] as string }));
  if (wanted.length === 0) return { ok: true, media: [] };
  const rows = await runner.all(
    `select "id" from "media" where "site_id" = ? and "mime_type" like 'image/%' and "id" in (${wanted.map(() => "?").join(", ")})`,
    [siteId, ...wanted.map((w) => w.id)],
  );
  const found = new Set(rows.map((r) => String(r["id"])));
  const media: { mediaId: string; field: string }[] = [];
  for (const w of wanted) {
    if (found.has(w.id)) media.push({ mediaId: w.id, field: `field:${w.def.key}` });
    else if (strict)
      return {
        ok: false,
        message: `"${w.def.label}" must be a picture from the library.`,
        field: w.def.key,
      };
  }
  return { ok: true, media };
}

/**
 * Checks the links of an entry: each one must be a published entry of the type the field links to. (An older link whose
 * entry has since gone is not checked here: it shows as empty on the page and as "deleted item" on the edit screen.)
 */
export async function checkRelations(
  runner: SqlRunner,
  siteId: string,
  defs: FieldDef[],
  values: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string; field: string }> {
  for (const d of defs) {
    const id = values[d.key];
    if (d.type !== "relation" || typeof id !== "string") continue;
    const found = await runner.all(
      `select "id" from "entries" where "site_id" = ? and "id" = ? and "type_key" = ? and "status" = 'published'`,
      [siteId, id, d.target ?? ""],
    );
    if (found.length === 0)
      return {
        ok: false,
        message: `"${d.label}" must be a published ${d.target} entry.`,
        field: d.key,
      };
  }
  return { ok: true };
}

/** The published entries of a type, for the choice box of a link field (the newest names first is not needed: by title). */
export async function entryChoices(
  runner: SqlRunner,
  siteId: string,
  typeKey: string,
): Promise<{ id: string; title: string }[]> {
  const rows = await runner.all(
    `select "id", "title" from "entries" where "site_id" = ? and "type_key" = ? and "status" = 'published' and "locale" = '' order by "title" limit 500`,
    [siteId, typeKey],
  );
  return rows.map((r) => ({ id: String(r["id"]), title: String(r["title"]) }));
}

/** The field definitions of one type, for the edit screen. */
export async function fieldsOfType(
  runner: SqlRunner,
  siteId: string,
  typeKey: string,
): Promise<FieldDef[]> {
  return (await listContentTypes(runner, siteId)).find((t) => t.key === typeKey)?.fields ?? [];
}
