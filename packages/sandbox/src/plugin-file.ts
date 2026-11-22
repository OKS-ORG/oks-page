// The plugin file: what `oks pack` writes and what an owner uploads in Tools > Plugins (spec 04, sections 3 and 10).
// One JSON file holds the manifest, the built bundle and the bundle's hash, so a plugin can be moved between computers
// without a network, and the same file can come from a marketplace later. Nothing here runs the code.
import { createHash } from "node:crypto";
import { readAdminPages, type AdminPageInfo } from "./admin-pages.js";
import { KNOWN_PERMISSIONS } from "./permission-text.js";
import type {
  ItemField,
  JobInfo,
  RouteInfo,
  SettingField,
  SettingOption,
  SettingsSchema,
} from "./types.js";

export const PLUGIN_FILE_FORMAT = 1;
/** The biggest plugin file the site takes (the bundle itself is limited more tightly by `oks check`). */
export const PLUGIN_FILE_MAX_BYTES = 5 * 1024 * 1024;

export interface PluginFileManifest {
  id: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  permissions: string[];
  hooks: string[];
  blocks: string[];
  /** The name shown in the editor and the settings form of each block, by block name. */
  blockInfo?: Record<string, { label: string; settings?: SettingsSchema }>;
  priority?: number;
  settings?: SettingsSchema;
  /** The addresses the plugin adds, by route name (needs the permission `routes:public`). */
  routes?: Record<string, RouteInfo>;
  /** The screens the plugin adds to the admin, as data (needs the permission `admin:pages`). */
  adminPages?: AdminPageInfo[];
  /** The tasks the plugin runs by itself on a timer, by name. */
  jobs?: Record<string, JobInfo>;
}

export interface PluginFile {
  format: typeof PLUGIN_FILE_FORMAT;
  manifest: PluginFileManifest;
  /** The production bundle: one JavaScript file. */
  code: string;
  /** sha256 of `code`, as hex. */
  integrity: string;
}

const ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const HOOK = /^[a-z]+:[A-Za-z]+$/;
const BLOCK = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SETTING_KEY = /^[a-z][a-z0-9_]{0,39}$/;

export const hashOfCode = (code: string): string => createHash("sha256").update(code).digest("hex");

/** True for a permission the product knows: one of the list in spec 04, or `network:fetch:<host name>`. */
export function isKnownPermission(permission: string): boolean {
  const host = /^network:fetch:(.+)$/.exec(permission)?.[1];
  if (host !== undefined) return HOST.test(host);
  return (KNOWN_PERMISSIONS as readonly string[]).includes(permission);
}

export function makePluginFile(manifest: PluginFileManifest, code: string): PluginFile {
  return { format: PLUGIN_FILE_FORMAT, manifest, code, integrity: hashOfCode(code) };
}

export type PluginFileResult = { ok: true; file: PluginFile } | { ok: false; message: string };

const bad = (message: string): PluginFileResult => ({ ok: false, message });

const list = (value: unknown, label: string, test: (s: string) => boolean): string[] | string => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    return `"${label}" must be a list of text.`;
  const items = value as string[];
  if (items.length > 100) return `"${label}" has too many entries.`;
  const wrong = items.find((v) => !test(v));
  if (wrong !== undefined)
    return `"${label}" has an entry that is not valid: ${wrong.slice(0, 60)}.`;
  if (new Set(items).size !== items.length) return `"${label}" lists something twice.`;
  return items;
};

export const LIST_ITEMS_MOST = 50;
export const LIST_ITEMS_DEFAULT = 30;
const LIST_ITEM_FIELDS_MOST = 8;
const OPTIONS_MOST = 30;
const TEXT_DEFAULT_MOST = 2000;

/** The choices of a drop-down list, or the words for what is wrong with them. */
function readOptions(value: unknown): SettingOption[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPTIONS_MOST) return null;
  const out: SettingOption[] = [];
  for (const o of value as unknown[]) {
    const x = o as { value?: unknown; label?: unknown } | null;
    if (
      x === null ||
      typeof x !== "object" ||
      typeof x.value !== "string" ||
      x.value.length > 60 ||
      typeof x.label !== "string" ||
      x.label.length === 0 ||
      x.label.length > 80 ||
      out.some((y) => y.value === x.value)
    )
      return null;
    out.push({ value: x.value, label: x.label });
  }
  return out;
}

/** The answers asked for each item of a list setting, or null when they are not valid. */
function readItemFields(value: unknown): Record<string, ItemField> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > LIST_ITEM_FIELDS_MOST) return null;
  const out: Record<string, ItemField> = {};
  for (const [key, raw] of entries) {
    const f = raw as { type?: unknown; label?: unknown; options?: unknown } | null;
    if (
      !SETTING_KEY.test(key) ||
      f === null ||
      typeof f !== "object" ||
      (f.type !== "text" && f.type !== "boolean") ||
      typeof f.label !== "string" ||
      f.label.length === 0 ||
      f.label.length > 80
    )
      return null;
    let options: SettingOption[] | undefined;
    if (f.options !== undefined) {
      if (f.type !== "text") return null;
      const read = readOptions(f.options);
      if (read === null) return null;
      options = read;
    }
    out[key] = { type: f.type, label: f.label, ...(options ? { options } : {}) };
  }
  return out;
}

/** The items a new block starts with: each answer is a text of a sound length or a yes or no, of the kind asked for. */
function readListDefault(
  value: unknown,
  item: Record<string, ItemField>,
  most: number,
): Record<string, string | boolean>[] | null {
  if (!Array.isArray(value) || value.length > most) return null;
  const out: Record<string, string | boolean>[] = [];
  for (const row of value as unknown[]) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
    const one: Record<string, string | boolean> = {};
    for (const [key, v] of Object.entries(row as Record<string, unknown>)) {
      const f = item[key];
      if (!f) return null;
      if (f.type === "boolean" ? typeof v !== "boolean" : typeof v !== "string" || v.length > 500)
        return null;
      if (f.options && !f.options.some((o) => o.value === v)) return null;
      one[key] = v as string | boolean;
    }
    out.push(one);
  }
  return out;
}

/**
 * A list of settings, or the words for what is wrong with it. In a block's settings (`block` true) a text may be a
 * drop-down list, a list of items may be asked for, and any setting may say what a new block starts with.
 */
function readSettings(value: unknown, where: string, block = false): SettingsSchema | string {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return `The plugin's ${where} are not valid.`;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 40) return `The plugin has too many ${where}.`;
  const out: SettingsSchema = {};
  for (const [key, field] of entries) {
    const ft = field as {
      type?: unknown;
      label?: unknown;
      options?: unknown;
      item?: unknown;
      most?: unknown;
      itemName?: unknown;
      default?: unknown;
    } | null;
    const types = block
      ? ["text", "number", "boolean", "secret", "list"]
      : ["text", "number", "boolean", "secret"];
    if (
      !SETTING_KEY.test(key) ||
      ft === null ||
      typeof ft !== "object" ||
      !types.includes(String(ft.type)) ||
      (ft.label !== undefined && (typeof ft.label !== "string" || ft.label.length > 80))
    )
      return `The setting "${key}" is not valid.`;
    const read: SettingField = {
      type: ft.type as SettingField["type"],
      ...(typeof ft.label === "string" ? { label: ft.label } : {}),
    };
    const bad = `The setting "${key}" is not valid.`;
    if (
      !block &&
      (ft.options !== undefined ||
        ft.item !== undefined ||
        ft.most !== undefined ||
        ft.itemName !== undefined ||
        ft.default !== undefined)
    )
      return bad;
    if (ft.options !== undefined) {
      const options = ft.type === "text" ? readOptions(ft.options) : null;
      if (options === null) return bad;
      read.options = options;
    }
    if (ft.type === "list") {
      const item = readItemFields(ft.item);
      if (item === null) return bad;
      const most = ft.most === undefined ? LIST_ITEMS_DEFAULT : ft.most;
      if (typeof most !== "number" || !Number.isInteger(most) || most < 1 || most > LIST_ITEMS_MOST)
        return bad;
      read.item = item;
      read.most = most;
      if (ft.itemName !== undefined) {
        if (typeof ft.itemName !== "string" || !/^[a-z][a-z ]{0,29}$/.test(ft.itemName)) return bad;
        read.itemName = ft.itemName;
      }
      if (ft.default !== undefined) {
        const rows = readListDefault(ft.default, item, most);
        if (rows === null) return bad;
        read.default = rows;
      }
    } else {
      if (ft.item !== undefined || ft.most !== undefined || ft.itemName !== undefined) return bad;
      if (ft.default !== undefined) {
        const d = ft.default;
        const sound =
          ft.type === "text"
            ? typeof d === "string" &&
              d.length <= TEXT_DEFAULT_MOST &&
              (!read.options || read.options.some((o) => o.value === d))
            : ft.type === "number"
              ? typeof d === "number" && Number.isFinite(d)
              : ft.type === "boolean" && typeof d === "boolean";
        if (!sound) return bad;
        read.default = d;
      }
    }
    out[key] = read;
  }
  return out;
}

export const ROUTE_BODY_DEFAULT = 20_000;
export const ROUTE_BODY_MOST = 100_000;

/** The routes of a manifest, or the words for what is wrong with them. */
export function readRoutes(value: unknown): Record<string, RouteInfo> | string {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "The plugin's routes are not valid.";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) return "The plugin has too many routes.";
  const out: Record<string, RouteInfo> = {};
  for (const [name, raw] of entries) {
    const r = raw as { method?: unknown; maxBytes?: unknown; signedIn?: unknown } | null;
    if (
      !BLOCK.test(name) ||
      r === null ||
      typeof r !== "object" ||
      (r.method !== "GET" && r.method !== "POST") ||
      (r.maxBytes !== undefined &&
        (typeof r.maxBytes !== "number" ||
          !Number.isInteger(r.maxBytes) ||
          r.maxBytes < 0 ||
          r.maxBytes > ROUTE_BODY_MOST)) ||
      (r.signedIn !== undefined && typeof r.signedIn !== "boolean")
    )
      return `The route "${name.slice(0, 40)}" is not valid.`;
    out[name] = {
      method: r.method,
      ...(r.maxBytes !== undefined ? { maxBytes: r.maxBytes as number } : {}),
      ...(r.signedIn ? { signedIn: true } : {}),
    };
  }
  return out;
}

export const JOBS_MOST = 5;
export const JOB_EVERY_LEAST = 5;
export const JOB_EVERY_MOST = 7 * 24 * 60;

/** The jobs of a manifest, or the words for what is wrong with them. */
export function readJobs(value: unknown): Record<string, JobInfo> | string {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "The plugin's jobs are not valid.";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > JOBS_MOST) return "The plugin has too many jobs.";
  const out: Record<string, JobInfo> = {};
  for (const [name, raw] of entries) {
    const j = raw as { everyMinutes?: unknown } | null;
    if (
      !BLOCK.test(name) ||
      j === null ||
      typeof j !== "object" ||
      typeof j.everyMinutes !== "number" ||
      !Number.isInteger(j.everyMinutes) ||
      j.everyMinutes < JOB_EVERY_LEAST ||
      j.everyMinutes > JOB_EVERY_MOST
    )
      return `The job "${name.slice(0, 40)}" is not valid: "everyMinutes" must be a whole number from ${JOB_EVERY_LEAST} to ${JOB_EVERY_MOST}.`;
    out[name] = { everyMinutes: j.everyMinutes };
  }
  return out;
}

/** Reads the text of a plugin file and checks every part of it. A bad file says in plain words what is wrong. */
export function readPluginFile(text: string): PluginFileResult {
  if (Buffer.byteLength(text) > PLUGIN_FILE_MAX_BYTES)
    return bad("This file is too big to be a plugin.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("This is not a plugin file. Make one with `oks pack`.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return bad("This is not a plugin file. Make one with `oks pack`.");
  const f = raw as Record<string, unknown>;
  if (f["format"] !== PLUGIN_FILE_FORMAT)
    return bad("This plugin file is from a different version of the tool and cannot be read.");
  if (typeof f["code"] !== "string" || f["code"].length === 0)
    return bad("The plugin file has no code.");
  if (typeof f["integrity"] !== "string" || f["integrity"] !== hashOfCode(f["code"]))
    return bad("The plugin file was changed after it was made: its code does not match its hash.");
  const m = f["manifest"];
  if (m === null || typeof m !== "object" || Array.isArray(m))
    return bad("The plugin file has no manifest.");
  const mm = m as Record<string, unknown>;
  if (typeof mm["id"] !== "string" || !ID.test(mm["id"]))
    return bad('The plugin\'s "id" must be 3 to 40 lower-case letters, digits or hyphens.');
  if (typeof mm["version"] !== "string" || !VERSION.test(mm["version"]))
    return bad('The plugin\'s "version" must look like 1.0.0.');
  const text1 = (key: string, max: number): string | null =>
    typeof mm[key] === "string" && (mm[key] as string).length <= max ? (mm[key] as string) : null;
  const displayName = text1("displayName", 80) ?? mm["id"];
  const description = text1("description", 300);
  const author = text1("author", 80);
  if (description === null || author === null)
    return bad(
      "The plugin's description (at most 300 characters) and author (at most 80) are needed.",
    );
  const permissions = list(mm["permissions"], "permissions", isKnownPermission);
  if (typeof permissions === "string") return bad(permissions);
  const hooks = list(mm["hooks"], "hooks", (s) => HOOK.test(s));
  if (typeof hooks === "string") return bad(hooks);
  const blocks = list(mm["blocks"], "blocks", (s) => BLOCK.test(s));
  if (typeof blocks === "string") return bad(blocks);
  let priority: number | undefined;
  if (mm["priority"] !== undefined) {
    if (
      typeof mm["priority"] !== "number" ||
      !Number.isInteger(mm["priority"]) ||
      mm["priority"] < 0 ||
      mm["priority"] > 100
    )
      return bad('The plugin\'s "priority" must be a whole number from 0 to 100.');
    priority = mm["priority"];
  }
  let settings: SettingsSchema | undefined;
  if (mm["settings"] !== undefined) {
    const read = readSettings(mm["settings"], "settings");
    if (typeof read === "string") return bad(read);
    settings = read;
  }
  let routes: Record<string, RouteInfo> | undefined;
  if (mm["routes"] !== undefined) {
    const read = readRoutes(mm["routes"]);
    if (typeof read === "string") return bad(read);
    if (Object.keys(read).length > 0 && !permissions.includes("routes:public"))
      return bad('A plugin with routes must ask for the permission "routes:public".');
    routes = read;
  }
  let jobs: Record<string, JobInfo> | undefined;
  if (mm["jobs"] !== undefined) {
    const read = readJobs(mm["jobs"]);
    if (typeof read === "string") return bad(read);
    jobs = read;
  }
  let adminPages: AdminPageInfo[] | undefined;
  if (mm["adminPages"] !== undefined) {
    const read = readAdminPages(mm["adminPages"]);
    if (typeof read === "string") return bad(read);
    if (read.length > 0 && !permissions.includes("admin:pages"))
      return bad('A plugin with admin pages must ask for the permission "admin:pages".');
    adminPages = read;
  }
  let blockInfo: PluginFileManifest["blockInfo"];
  if (mm["blockInfo"] !== undefined) {
    const info = mm["blockInfo"];
    if (info === null || typeof info !== "object" || Array.isArray(info))
      return bad('The plugin\'s "blockInfo" is not valid.');
    blockInfo = {};
    for (const [name, entry] of Object.entries(info as Record<string, unknown>)) {
      const e = entry as { label?: unknown; settings?: unknown } | null;
      if (
        !blocks.includes(name) ||
        e === null ||
        typeof e !== "object" ||
        typeof e.label !== "string" ||
        e.label.length === 0 ||
        e.label.length > 80
      )
        return bad(`The information about the block "${name}" is not valid.`);
      let blockSettings: SettingsSchema | undefined;
      if (e.settings !== undefined) {
        const read = readSettings(e.settings, `block "${name}"`, true);
        if (typeof read === "string") return bad(read);
        // A block's fields are drawn in the editor, where a secret has no place.
        if (Object.values(read).some((f) => f.type === "secret"))
          return bad(`The block "${name}" cannot have a secret setting.`);
        blockSettings = read;
      }
      blockInfo[name] = { label: e.label, ...(blockSettings ? { settings: blockSettings } : {}) };
    }
  }
  return {
    ok: true,
    file: {
      format: PLUGIN_FILE_FORMAT,
      manifest: {
        id: mm["id"],
        version: mm["version"],
        displayName,
        description,
        author,
        permissions,
        hooks,
        blocks,
        ...(blockInfo ? { blockInfo } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(settings ? { settings } : {}),
        ...(routes && Object.keys(routes).length > 0 ? { routes } : {}),
        ...(adminPages && adminPages.length > 0 ? { adminPages } : {}),
        ...(jobs && Object.keys(jobs).length > 0 ? { jobs } : {}),
      },
      code: f["code"],
      integrity: f["integrity"],
    },
  };
}
