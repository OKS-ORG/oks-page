// Plugin blocks (spec 04, section 8): a plugin adds a block named `<plugin-id>-<block>` and returns a tree of core blocks
// for it. The saved page only holds a marker for the block (the renderer leaves one); the block is drawn when the page is
// shown, so a plugin that was changed, updated or switched off since the page was saved is taken into account at once.
// What a plugin returns goes through the same block checks as everything a person writes, every time it is drawn.
import { checkBlocks } from "@oks-page/content-safety";
import { writeContentBlocks } from "@oks-page/core";
import type { SqlRunner } from "@oks-page/db";
import { getRunner, getSiteId } from "./db";
import { pluginHost } from "./plugin-runtime";

/** One value of a drop-down list in a block's settings. */
export interface PluginBlockOption {
  value: string;
  label: string;
}

/** One setting of a plugin's block, as the page builder draws it. */
export type PluginBlockField =
  | { key: string; label: string; type: "text"; options?: PluginBlockOption[]; default?: string }
  | { key: string; label: string; type: "number"; default?: number }
  | { key: string; label: string; type: "boolean"; default?: boolean }
  | {
      key: string;
      label: string;
      type: "list";
      itemName: string;
      item: {
        key: string;
        label: string;
        type: "text" | "boolean";
        options?: PluginBlockOption[];
      }[];
      most: number;
      default?: Record<string, string | boolean>[];
    };

export interface PluginBlockType {
  /** The block's type in a page: `<plugin-id>-<block>`. */
  type: string;
  pluginId: string;
  block: string;
  /** The name in the editor's list of blocks. */
  label: string;
  /** The fields of the block's settings (a secret has no place in the editor). */
  fields: PluginBlockField[];
}

const parse = (value: unknown): Record<string, unknown> => {
  try {
    const v = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const options = (v: unknown): PluginBlockOption[] | undefined =>
  Array.isArray(v)
    ? (v as unknown[]).flatMap((o) => {
        const x = parse(o);
        return typeof x["value"] === "string" && typeof x["label"] === "string"
          ? [{ value: x["value"], label: x["label"] }]
          : [];
      })
    : undefined;

/** One setting of a block as the editor draws it. The manifest was checked when the plugin was added; this is careful anyway. */
function fieldOf(key: string, field: Record<string, unknown>): PluginBlockField[] {
  const type = field["type"];
  const label = typeof field["label"] === "string" ? field["label"] : key;
  if (type === "boolean")
    return [
      {
        key,
        label,
        type,
        ...(typeof field["default"] === "boolean" ? { default: field["default"] } : {}),
      },
    ];
  if (type === "number")
    return [
      {
        key,
        label,
        type,
        ...(typeof field["default"] === "number" ? { default: field["default"] } : {}),
      },
    ];
  if (type === "text") {
    const list = options(field["options"]);
    return [
      {
        key,
        label,
        type,
        ...(list && list.length > 0 ? { options: list } : {}),
        ...(typeof field["default"] === "string" ? { default: field["default"] } : {}),
      },
    ];
  }
  if (type === "list") {
    const item = Object.entries(parse(field["item"])).flatMap(([k, raw]) => {
      const x = parse(raw);
      const t = x["type"];
      if (t !== "text" && t !== "boolean") return [];
      const list = options(x["options"]);
      return [
        {
          key: k,
          label: typeof x["label"] === "string" ? x["label"] : k,
          type: t as "text" | "boolean",
          ...(list && list.length > 0 ? { options: list } : {}),
        },
      ];
    });
    if (item.length === 0) return [];
    const most = Number(field["most"]);
    return [
      {
        key,
        label,
        type,
        itemName: typeof field["itemName"] === "string" ? field["itemName"] : "item",
        item,
        most: Number.isInteger(most) && most >= 1 && most <= 50 ? most : 30,
        ...(Array.isArray(field["default"])
          ? { default: field["default"] as Record<string, string | boolean>[] }
          : {}),
      },
    ];
  }
  return [];
}

/** The blocks of the plugins that are switched on. */
export async function pluginBlockTypes(
  runner: SqlRunner,
  siteId: string,
): Promise<PluginBlockType[]> {
  const rows = await runner.all(
    `select "key", "manifest" from "extensions" where "site_id" = ? and "kind" = 'plugin' and "status" = 'enabled' and "code" is not null order by "key"`,
    [siteId],
  );
  const out: PluginBlockType[] = [];
  for (const row of rows) {
    const pluginId = String(row["key"]);
    const manifest = parse(row["manifest"]);
    const names = Array.isArray(manifest["blocks"]) ? (manifest["blocks"] as unknown[]) : [];
    const info = parse(manifest["blockInfo"]);
    for (const name of names) {
      if (typeof name !== "string") continue;
      const entry = parse(info[name]);
      const settings = parse(entry["settings"]);
      out.push({
        type: `${pluginId}-${name}`,
        pluginId,
        block: name,
        label: `${typeof entry["label"] === "string" ? entry["label"] : name} (${pluginId})`,
        fields: Object.entries(settings).flatMap(([key, f]) => fieldOf(key, parse(f))),
      });
    }
  }
  return out;
}

const MARKER = /<div data-oks-plugin-block="([^"]*)" data-oks-block-id="([^"]*)"><\/div>/g;
/** The most plugin blocks one page draws; the rest are left out (a page cannot make the site run a plugin without end). */
const MOST_BLOCKS = 40;
/** The most HTML one plugin block may add. */
const MOST_HTML = 100_000;

interface Node {
  id?: unknown;
  props?: unknown;
  children?: unknown;
}

/** The block with this id in a page's body. */
function findBlock(blocks: unknown, id: string): Node | null {
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks as Node[]) {
    if (b && b.id === id) return b;
    const inner = findBlock(b?.children, id);
    if (inner) return inner;
  }
  return null;
}

/**
 * The page's HTML with every plugin block drawn: from the plugin that is switched on, checked like any block. A block
 * whose plugin is off, gone, failed or too slow is left out, and the rest of the page is shown (fail open).
 */
export async function drawPluginBlocks(html: string, body: unknown): Promise<string> {
  if (!html.includes("data-oks-plugin-block")) return html;
  const found = [...html.matchAll(MARKER)];
  let types: PluginBlockType[] = [];
  let host: Awaited<ReturnType<typeof pluginHost>> | null = null;
  try {
    types = await pluginBlockTypes(getRunner(), await getSiteId());
    if (types.length > 0) host = await pluginHost();
  } catch {
    host = null;
  }
  const blocks = (body as { blocks?: unknown } | null)?.blocks;
  const drawn = new Map<string, string>();
  let count = 0;
  for (const m of found) {
    const [, type = "", id = ""] = m;
    const key = `${type}\n${id}`;
    if (drawn.has(key)) continue;
    drawn.set(key, "");
    const known = types.find((t) => t.type === type);
    if (!host || !known || ++count > MOST_BLOCKS) continue;
    const node = findBlock(blocks, id);
    const props = node && typeof node.props === "object" && node.props ? node.props : {};
    try {
      const result = await host.call(known.pluginId, "block", known.block, props);
      if (
        !result.ok ||
        result.skipped ||
        result.result === null ||
        typeof result.result !== "object"
      )
        continue;
      const checked = checkBlocks({ version: 1, blocks: [result.result] } as never);
      const written = writeContentBlocks(checked.body.blocks, new Map());
      if (written.html.length <= MOST_HTML) drawn.set(key, written.html);
    } catch {
      // a plugin never stops the page from showing
    }
  }
  return html.replace(
    MARKER,
    (_all, type: string, id: string) => drawn.get(`${type}\n${id}`) ?? "",
  );
}
