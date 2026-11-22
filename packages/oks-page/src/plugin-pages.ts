// Admin pages of plugins (spec 04, section 9). A plugin describes a screen as data in its manifest; this reads the
// plugin's own stored items and turns them into rows for the admin to draw. No plugin code runs here: the core reads the
// plugin's storage itself, and a button on a row does one of two fixed things (delete the item, or set one field to a
// fixed word). Only people who manage plugins may open the pages, because what a plugin stores may be private.
import type { Actor } from "@oks-page/core";
import { newId, type SqlRunner } from "@oks-page/db";
import { collectionOf, readAdminPages, type AdminPageInfo } from "@oks-page/sandbox";
import { deleteItemFiles } from "./plugin-files";

export type PageResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };

const fail = (code: "forbidden" | "invalid" | "not_found", message: string) =>
  ({ ok: false, code, message }) as const;

/** A page the menu can link to: the plugin, and the page's title. */
export interface PluginPageLink {
  plugin: string;
  pluginName: string;
  id: string;
  title: string;
}

export interface PluginCell {
  /** What is shown (cut short when it is long). */
  text: string;
  /** For a column of files: a link to each, for people who may open them. */
  links?: { text: string; href: string }[];
  /** The whole text, when `text` was cut. */
  full?: string;
}

export interface PluginRow {
  key: string;
  cells: PluginCell[];
}

export interface PluginPageView {
  plugin: string;
  pluginName: string;
  title: string;
  columns: string[];
  filters: string[];
  /** Which filter was used (an index into `filters`); -1 when the page has none. */
  filter: number;
  actions: { id: string; label: string; kind: "delete" | "set"; confirm: boolean }[];
  rows: PluginRow[];
  /** The key to pass as `after` to read the next rows, or null at the end. */
  next: string | null;
  empty: string;
  canExport: boolean;
}

const PAGE_SIZE = 50;
const BATCH = 200;
const SCAN_MOST = 2000;
const EXPORT_MOST = 5000;
const EXPORT_SCAN_MOST = 20_000;

const parse = (value: unknown): Record<string, unknown> => {
  const v = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
};

interface Found {
  extensionId: string;
  pluginName: string;
  page: AdminPageInfo;
  collection: string;
}

/** The page, when the plugin is installed, switched on, was given `admin:pages`, and declares the page. */
async function findPage(
  runner: SqlRunner,
  siteId: string,
  plugin: string,
  pageId: string,
): Promise<PageResult<{ found: Found }>> {
  const row = (
    await runner.all(
      `select "id", "status", "manifest" from "extensions" where "site_id" = ? and "key" = ? and "kind" = 'plugin'`,
      [siteId, plugin],
    )
  )[0];
  if (!row) return fail("not_found", "This plugin is not installed.");
  const manifest = parse(row["manifest"]);
  const allowed = await runner.all(
    `select 1 as x from "extension_permissions" where "extension_id" = ? and "permission" = 'admin:pages'`,
    [String(row["id"])],
  );
  // A stored manifest is read again with the same rules as a plugin file, so a damaged one shows nothing.
  const pages = allowed.length > 0 ? readAdminPages(manifest["adminPages"] ?? []) : [];
  const page = typeof pages === "string" ? undefined : pages.find((p) => p.id === pageId);
  if (!page) return fail("not_found", "This page does not exist.");
  if (String(row["status"]) !== "enabled")
    return fail("not_found", "This page is not available while the plugin is switched off.");
  const collection = collectionOf(page.view.source);
  if (collection === null) return fail("not_found", "This page does not exist.");
  return {
    ok: true,
    found: {
      extensionId: String(row["id"]),
      pluginName: typeof manifest["displayName"] === "string" ? manifest["displayName"] : plugin,
      page,
      collection,
    },
  };
}

/** The pages of the plugins that are switched on and may add admin pages. */
export async function listPluginPages(
  runner: SqlRunner,
  siteId: string,
): Promise<PluginPageLink[]> {
  const rows = await runner.all(
    `select e."id", e."key", e."manifest" from "extensions" e
       join "extension_permissions" p on p."extension_id" = e."id" and p."permission" = 'admin:pages'
      where e."site_id" = ? and e."kind" = 'plugin' and e."status" = 'enabled' order by e."key"`,
    [siteId],
  );
  const out: PluginPageLink[] = [];
  for (const r of rows) {
    const manifest = parse(r["manifest"]);
    const pages = readAdminPages(manifest["adminPages"] ?? []);
    if (typeof pages === "string") continue;
    const pluginName =
      typeof manifest["displayName"] === "string" ? manifest["displayName"] : String(r["key"]);
    for (const p of pages)
      out.push({ plugin: String(r["key"]), pluginName, id: p.id, title: p.title });
  }
  return out;
}

/** A value of a stored item by name: `status`, `values.email`, `$key`, `$updatedAt`. Only an item's own fields are read. */
function fieldOf(item: { key: string; value: unknown; updatedAt: number }, path: string): unknown {
  if (path === "$key") return item.key;
  if (path === "$updatedAt") return item.updatedAt;
  let at: unknown = item.value;
  for (const part of path.split(".")) {
    if (
      at === null ||
      typeof at !== "object" ||
      Array.isArray(at) ||
      !Object.prototype.hasOwnProperty.call(at, part)
    )
      return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

const two = (n: number) => String(n).padStart(2, "0");

/** The files of a stored item that a column of files shows: each has an id and a name. */
function filesOf(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap((f) => {
    const x = f !== null && typeof f === "object" ? (f as Record<string, unknown>) : {};
    return typeof x["id"] === "string" && x["id"].length === 26 && typeof x["name"] === "string"
      ? [{ id: x["id"], name: x["name"] }]
      : [];
  });
}

function show(value: unknown, format: "text" | "datetime" | "files"): string {
  if (value === null || value === undefined) return "";
  if (format === "files")
    return filesOf(value)
      .map((f) => f.name)
      .join("; ");
  if (format === "datetime") {
    const d = typeof value === "number" || typeof value === "string" ? new Date(value) : null;
    if (d && Number.isFinite(d.getTime()))
      return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
    return "";
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return "";
}

interface Item {
  key: string;
  value: unknown;
  updatedAt: number;
}

/** Reads up to `most` items that match, from `after` on, scanning at most `scanMost` stored items. */
async function readItems(
  runner: SqlRunner,
  found: Found,
  filter: { field: string; value: string } | null,
  after: string | null,
  most: number,
  scanMost: number,
): Promise<{ items: Item[]; next: string | null }> {
  const desc = (found.page.view.order ?? "desc") === "desc";
  const items: Item[] = [];
  let cursor = after;
  let scanned = 0;
  for (;;) {
    const rows = await runner.all(
      `select "key", "value", "updated_at" from "extension_storage" where "extension_id" = ? and "collection" = ?${
        cursor === null ? "" : ` and "key" ${desc ? "<" : ">"} ?`
      } order by "key" ${desc ? "desc" : "asc"} limit ${BATCH}`,
      cursor === null
        ? [found.extensionId, found.collection]
        : [found.extensionId, found.collection, cursor],
    );
    for (const r of rows) {
      scanned += 1;
      cursor = String(r["key"]);
      let value: unknown = r["value"];
      if (typeof value === "string" && runner.dialect === "sqlite") {
        try {
          value = JSON.parse(value);
        } catch {
          value = null;
        }
      }
      const item: Item = {
        key: cursor,
        value,
        updatedAt: new Date(r["updated_at"] as string | number | Date).getTime(),
      };
      if (filter && String(fieldOf(item, filter.field) ?? "") !== filter.value) continue;
      items.push(item);
      if (items.length >= most) return { items, next: cursor };
    }
    if (rows.length < BATCH) return { items, next: null };
    if (scanned >= scanMost) return { items, next: cursor };
  }
}

function cellsOf(page: AdminPageInfo, item: Item): PluginCell[] {
  return page.view.columns.map((c) => {
    if (c.format === "files") {
      const files = filesOf(fieldOf(item, c.field));
      return {
        text: files.map((f) => f.name).join(", "),
        ...(files.length > 0
          ? { links: files.map((f) => ({ text: f.name, href: `/api/admin/plugin-files/${f.id}` })) }
          : {}),
      };
    }
    const full = show(fieldOf(item, c.field), c.format ?? "text");
    const max = c.truncate ?? 80;
    return full.length > max
      ? { text: `${full.slice(0, max)}…`, full: full.slice(0, 4000) }
      : { text: full };
  });
}

const filterOf = (page: AdminPageInfo, index: number | undefined) => {
  const filters = page.view.filters ?? [];
  if (filters.length === 0) return { index: -1, rule: null };
  const i = index !== undefined && index >= 0 && index < filters.length ? index : 0;
  return { index: i, rule: { field: filters[i]!.field, value: filters[i]!.value } };
};

/** One page of rows. `filter` is an index into the page's filters; `after` is the `next` of the page before. */
export async function loadPluginPage(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  plugin: string,
  pageId: string,
  options: { filter?: number; after?: string | null } = {},
): Promise<PageResult<{ view: PluginPageView }>> {
  if (!actor.can("plugins.manage")) return fail("forbidden", "You may not manage plugins.");
  const got = await findPage(runner, siteId, plugin, pageId);
  if (!got.ok) return got;
  const { found } = got;
  const f = filterOf(found.page, options.filter);
  const read = await readItems(
    runner,
    found,
    f.rule,
    typeof options.after === "string" && options.after.length > 0 ? options.after : null,
    PAGE_SIZE,
    SCAN_MOST,
  );
  const v = found.page.view;
  return {
    ok: true,
    view: {
      plugin,
      pluginName: found.pluginName,
      title: found.page.title,
      columns: v.columns.map((c) => c.label),
      filters: (v.filters ?? []).map((x) => x.label),
      filter: f.index,
      actions: (v.actions ?? []).map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        confirm: a.kind === "delete" || a.confirm === true,
      })),
      rows: read.items.map((item) => ({ key: item.key, cells: cellsOf(found.page, item) })),
      next: read.next,
      empty: v.empty ?? "There is nothing here yet.",
      canExport: v.export === true,
    },
  };
}

/** Does what a button on a row does. The names of the page, the action and the item go to the audit log, never the values. */
export async function actOnPluginPage(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  plugin: string,
  pageId: string,
  actionId: string,
  key: string,
): Promise<PageResult<object>> {
  if (!actor.can("plugins.manage")) return fail("forbidden", "You may not manage plugins.");
  const got = await findPage(runner, siteId, plugin, pageId);
  if (!got.ok) return got;
  const { found } = got;
  const action = (found.page.view.actions ?? []).find((a) => a.id === actionId);
  if (!action) return fail("invalid", "This page has no such action.");
  const rows = await runner.all(
    `select "value" from "extension_storage" where "extension_id" = ? and "collection" = ? and "key" = ?`,
    [found.extensionId, found.collection, key],
  );
  if (rows.length === 0) return fail("not_found", "This item is gone already.");
  if (action.kind === "delete") {
    await runner.all(
      `delete from "extension_storage" where "extension_id" = ? and "collection" = ? and "key" = ?`,
      [found.extensionId, found.collection, key],
    );
    // The files kept with the item go with it.
    await deleteItemFiles(runner, found.extensionId, found.collection, key);
  } else {
    let value = rows[0]!["value"];
    if (typeof value === "string" && runner.dialect === "sqlite")
      value = JSON.parse(value) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return fail("invalid", "This item cannot be changed.");
    const next = JSON.stringify({
      ...(value as Record<string, unknown>),
      [action.field!]: action.value,
    });
    await runner.all(
      `update "extension_storage" set "value" = ?, "size_bytes" = ?, "updated_at" = ? where "extension_id" = ? and "collection" = ? and "key" = ?`,
      [next, Buffer.byteLength(next), new Date(), found.extensionId, found.collection, key],
    );
  }
  await runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id", "detail", "created_at") values (?, ?, 'user', ?, 'plugin.page_action', 'plugin', ?, ?, ?)`,
    [
      newId(),
      siteId,
      actor.userId,
      plugin,
      JSON.stringify({ page: pageId, action: actionId, key }),
      new Date(),
    ],
  );
  return { ok: true };
}

/** A spreadsheet cell that starts with one of these is read as a formula by Excel and Sheets, so it gets a quote in front. */
const csvCell = (text: string): string => {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The items that match the filter as CSV (at most 5,000), with the page's columns and the whole text of each cell. */
export async function exportPluginPage(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  plugin: string,
  pageId: string,
  filter?: number,
): Promise<PageResult<{ csv: string; filename: string; cut: boolean }>> {
  if (!actor.can("plugins.manage")) return fail("forbidden", "You may not manage plugins.");
  const got = await findPage(runner, siteId, plugin, pageId);
  if (!got.ok) return got;
  const { found } = got;
  if (found.page.view.export !== true) return fail("not_found", "This page has no export.");
  const f = filterOf(found.page, filter);
  const read = await readItems(runner, found, f.rule, null, EXPORT_MOST, EXPORT_SCAN_MOST);
  const columns = found.page.view.columns;
  const lines = [columns.map((c) => csvCell(c.label)).join(",")];
  for (const item of read.items)
    lines.push(
      columns.map((c) => csvCell(show(fieldOf(item, c.field), c.format ?? "text"))).join(","),
    );
  await runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id", "detail", "created_at") values (?, ?, 'user', ?, 'plugin.page_export', 'plugin', ?, ?, ?)`,
    [
      newId(),
      siteId,
      actor.userId,
      plugin,
      JSON.stringify({ page: pageId, rows: read.items.length }),
      new Date(),
    ],
  );
  return {
    ok: true,
    csv: `${lines.join("\r\n")}\r\n`,
    filename: `${plugin}-${pageId}.csv`,
    cut: read.next !== null,
  };
}
