// Admin pages of a plugin (spec 04, section 9): a plugin describes a screen as data and the admin draws it with its own
// parts, so a plugin screen looks like the rest of the admin and no plugin code runs in the admin. This first kind is a
// table over one collection of the plugin's own storage, with filters, row actions and a CSV export. Nothing here runs code.

/** A name in a stored item: `status`, `values.email`, or `$key` and `$updatedAt` (the item's key and the time it was saved). */
const FIELD =
  /^(?:\$key|\$updatedAt|[A-Za-z_][A-Za-z0-9_]{0,39}(?:\.[A-Za-z_][A-Za-z0-9_]{0,39}){0,2})$/;
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COLLECTION = /^[a-z][a-z0-9_-]{0,39}$/;
const ACTION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const SETTABLE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

export const ADMIN_PAGES_MOST = 5;
export const ADMIN_COLUMNS_MOST = 8;
export const ADMIN_FILTERS_MOST = 6;
export const ADMIN_ACTIONS_MOST = 4;

export interface AdminColumn {
  field: string;
  label: string;
  /** `datetime` reads a number of milliseconds (or a date text) and shows the date and time. Default `text`. */
  format?: "text" | "datetime";
  /** Longer text is cut to this many characters and opens in full under a "Show all" control. Default 80, at most 400. */
  truncate?: number;
}

/** Shows only the items where `field` is `value` (a word like "new"). The first filter is the one shown first. */
export interface AdminFilter {
  label: string;
  field: string;
  value: string;
}

/** What a button on a row does: `delete` removes the item, `set` changes one top-level field to a fixed text. */
export interface AdminAction {
  id: string;
  label: string;
  kind: "delete" | "set";
  field?: string;
  value?: string;
  /** Ask "Are you sure?" first. Always asked for `delete`. */
  confirm?: boolean;
}

export interface AdminTableView {
  type: "table";
  /** `storage:<collection>`: the plugin's own storage. */
  source: string;
  /** Newest (largest key) first by default. */
  order?: "asc" | "desc";
  columns: AdminColumn[];
  filters?: AdminFilter[];
  actions?: AdminAction[];
  /** The words shown when there is nothing to list. */
  empty?: string;
  /** Offer "Download CSV" for the items that match the filter. */
  export?: boolean;
}

export interface AdminPageInfo {
  id: string;
  title: string;
  view: AdminTableView;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max ? v : null;

/** The collection a `storage:<collection>` source names, or null. */
export const collectionOf = (source: string): string | null => {
  const m = /^storage:(.+)$/.exec(source);
  return m && COLLECTION.test(m[1]!) ? m[1]! : null;
};

/** The admin pages of a manifest, or the words for what is wrong with them. */
export function readAdminPages(value: unknown): AdminPageInfo[] | string {
  if (!Array.isArray(value)) return "The plugin's adminPages must be a list.";
  if (value.length > ADMIN_PAGES_MOST) return "The plugin has too many admin pages.";
  const out: AdminPageInfo[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const bad = (why: string) =>
      `The admin page "${String(isObject(raw) ? raw["id"] : "").slice(0, 40)}" is not valid: ${why}`;
    if (!isObject(raw)) return "An admin page is not valid.";
    const id = raw["id"];
    if (typeof id !== "string" || !PAGE_ID.test(id))
      return bad("its id must be lower-case letters, digits and hyphens.");
    if (seen.has(id)) return bad("its id is used twice.");
    seen.add(id);
    const title = text(raw["title"], 80);
    if (title === null) return bad("it needs a title of at most 80 characters.");
    const v = raw["view"];
    if (!isObject(v) || v["type"] !== "table") return bad('its view must have the type "table".');
    const source = v["source"];
    if (typeof source !== "string" || collectionOf(source) === null)
      return bad('its source must look like "storage:messages".');
    if (v["order"] !== undefined && v["order"] !== "asc" && v["order"] !== "desc")
      return bad('"order" must be "asc" or "desc".');
    if (
      !Array.isArray(v["columns"]) ||
      v["columns"].length < 1 ||
      v["columns"].length > ADMIN_COLUMNS_MOST
    )
      return bad(`it needs 1 to ${ADMIN_COLUMNS_MOST} columns.`);
    const columns: AdminColumn[] = [];
    for (const c of v["columns"] as unknown[]) {
      if (!isObject(c)) return bad("a column is not valid.");
      const label = text(c["label"], 60);
      if (typeof c["field"] !== "string" || !FIELD.test(c["field"]) || label === null)
        return bad("a column needs a field name and a label of at most 60 characters.");
      if (c["format"] !== undefined && c["format"] !== "text" && c["format"] !== "datetime")
        return bad('a column\'s format must be "text" or "datetime".');
      if (
        c["truncate"] !== undefined &&
        (typeof c["truncate"] !== "number" ||
          !Number.isInteger(c["truncate"]) ||
          c["truncate"] < 10 ||
          c["truncate"] > 400)
      )
        return bad("a column's truncate must be a whole number from 10 to 400.");
      columns.push({
        field: c["field"],
        label,
        ...(c["format"] ? { format: c["format"] as "text" | "datetime" } : {}),
        ...(c["truncate"] !== undefined ? { truncate: c["truncate"] as number } : {}),
      });
    }
    let filters: AdminFilter[] | undefined;
    if (v["filters"] !== undefined) {
      if (!Array.isArray(v["filters"]) || v["filters"].length > ADMIN_FILTERS_MOST)
        return bad(`it may have up to ${ADMIN_FILTERS_MOST} filters.`);
      filters = [];
      for (const f of v["filters"] as unknown[]) {
        if (!isObject(f)) return bad("a filter is not valid.");
        const label = text(f["label"], 40);
        const value = text(f["value"], 60);
        if (
          typeof f["field"] !== "string" ||
          !FIELD.test(f["field"]) ||
          label === null ||
          value === null
        )
          return bad("a filter needs a label, a field name and a value.");
        filters.push({ label, field: f["field"], value });
      }
    }
    let actions: AdminAction[] | undefined;
    if (v["actions"] !== undefined) {
      if (!Array.isArray(v["actions"]) || v["actions"].length > ADMIN_ACTIONS_MOST)
        return bad(`it may have up to ${ADMIN_ACTIONS_MOST} actions.`);
      actions = [];
      const ids = new Set<string>();
      for (const a of v["actions"] as unknown[]) {
        if (!isObject(a)) return bad("an action is not valid.");
        const label = text(a["label"], 40);
        if (
          typeof a["id"] !== "string" ||
          !ACTION_ID.test(a["id"]) ||
          ids.has(a["id"]) ||
          label === null
        )
          return bad("an action needs its own id and a label of at most 40 characters.");
        ids.add(a["id"]);
        if (a["kind"] === "delete") {
          actions.push({
            id: a["id"],
            label,
            kind: "delete",
            confirm: true,
          });
        } else if (a["kind"] === "set") {
          const setValue = text(a["value"], 60);
          if (typeof a["field"] !== "string" || !SETTABLE.test(a["field"]) || setValue === null)
            return bad('a "set" action needs a field name and a value.');
          actions.push({
            id: a["id"],
            label,
            kind: "set",
            field: a["field"],
            value: setValue,
            ...(a["confirm"] === true ? { confirm: true } : {}),
          });
        } else return bad('an action\'s kind must be "delete" or "set".');
      }
    }
    if (v["empty"] !== undefined && text(v["empty"], 200) === null)
      return bad('"empty" must be text of at most 200 characters.');
    if (v["export"] !== undefined && typeof v["export"] !== "boolean")
      return bad('"export" must be true or false.');
    out.push({
      id,
      title,
      view: {
        type: "table",
        source,
        ...(v["order"] ? { order: v["order"] as "asc" | "desc" } : {}),
        columns,
        ...(filters && filters.length > 0 ? { filters } : {}),
        ...(actions && actions.length > 0 ? { actions } : {}),
        ...(v["empty"] !== undefined ? { empty: v["empty"] as string } : {}),
        ...(v["export"] === true ? { export: true } : {}),
      },
    });
  }
  return out;
}
