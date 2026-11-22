// What a plugin may say about the settings of its blocks (spec 04, section 8): drop-down lists, lists of items that the
// page builder draws with buttons to add, move and remove, and the values a new block starts with. Plugin-wide settings
// stay plain. A plain statement of what is wrong comes back for anything else.
import { describe, expect, test } from "vitest";
import { makePluginFile, readPluginFile } from "./plugin-file.js";

const manifest = (blockSettings: unknown, settings?: unknown) => ({
  id: "demo-blocks",
  version: "1.0.0",
  displayName: "Demo",
  description: "d",
  author: "a",
  permissions: [],
  hooks: [],
  blocks: ["card"],
  blockInfo: { card: { label: "Card", settings: blockSettings } },
  ...(settings ? { settings } : {}),
});
const read = (blockSettings: unknown, settings?: unknown) =>
  readPluginFile(
    JSON.stringify(
      makePluginFile(manifest(blockSettings, settings) as never, "export default {};"),
    ),
  );

const list = (over: Record<string, unknown> = {}) => ({
  type: "list",
  label: "Rows",
  itemName: "row",
  most: 5,
  item: {
    title: { type: "text", label: "Title" },
    kind: {
      type: "text",
      label: "Kind",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
    on: { type: "boolean", label: "On" },
  },
  default: [{ title: "One", kind: "a", on: true }],
  ...over,
});

describe("the settings of a plugin's block", () => {
  test("a list of items, a drop-down list and starting values are read, and nothing else is kept", () => {
    const r = read({
      rows: list(),
      mode: { type: "text", label: "Mode", options: [{ value: "x", label: "X" }], default: "x" },
      size: { type: "number", label: "Size", default: 3 },
      shout: { type: "boolean", label: "Shout", default: false },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.file.manifest.blockInfo!["card"]!.settings!;
    expect(s["rows"]).toMatchObject({ type: "list", itemName: "row", most: 5 });
    expect(s["rows"]!.default).toEqual([{ title: "One", kind: "a", on: true }]);
    expect(s["mode"]).toMatchObject({ options: [{ value: "x", label: "X" }], default: "x" });
    expect(s["size"]!.default).toBe(3);
    expect(s["shout"]!.default).toBe(false);
  });

  test("the most items, and the name of an item, have defaults", () => {
    const r = read({ rows: list({ most: undefined, itemName: undefined, default: undefined }) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.file.manifest.blockInfo!["card"]!.settings!["rows"]!;
    expect(rows.most).toBe(30);
    expect(rows.itemName).toBeUndefined();
  });

  test.each([
    ["a list with no item answers", list({ item: {} })],
    [
      "nine answers in an item",
      list({
        item: Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`k${i}`, { type: "text", label: "K" }]),
        ),
      }),
    ],
    ["an item answer that is a number", list({ item: { n: { type: "number", label: "N" } } })],
    [
      "an item answer with an unusable name",
      list({ item: { "Bad Key": { type: "text", label: "K" } } }),
    ],
    ["an item answer without a label", list({ item: { k: { type: "text" } } })],
    [
      "a choice twice",
      list({
        item: {
          k: {
            type: "text",
            label: "K",
            options: [
              { value: "a", label: "A" },
              { value: "a", label: "B" },
            ],
          },
        },
      }),
    ],
    ["more than 50 items", list({ most: 51 })],
    ["a most that is not a whole number", list({ most: 2.5 })],
    ["an item name with capitals", list({ itemName: "Row" })],
    ["a start with a key the item does not ask for", list({ default: [{ nope: "x" }] })],
    [
      "a start with more items than the most",
      list({ most: 1, default: [{ title: "a" }, { title: "b" }] }),
    ],
    ["a start that is not one of the choices", list({ default: [{ title: "a", kind: "zzz" }] })],
    ["a start with a text where a yes or no is asked", list({ default: [{ on: "yes" }] })],
    ["a start that is not a list", list({ default: "x" })],
  ])("%s is refused in plain words", (_name, rows) => {
    const r = read({ rows });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('The setting "rows" is not valid.');
  });

  test.each([
    ["options on a number", { type: "number", label: "N", options: [{ value: "1", label: "1" }] }],
    ["no choices at all", { type: "text", label: "T", options: [] }],
    [
      "a start that is not one of the choices",
      { type: "text", label: "T", options: [{ value: "a", label: "A" }], default: "b" },
    ],
    ["a start of the wrong kind", { type: "boolean", label: "B", default: "yes" }],
    ["an item on a text", { type: "text", label: "T", item: { k: { type: "text", label: "K" } } }],
    ["a most on a text", { type: "text", label: "T", most: 3 }],
  ])("%s is refused", (_name, setting) => {
    expect(read({ x: setting }).ok).toBe(false);
  });

  test("a plugin's own settings stay plain: no list, no drop-down list, no starting value", () => {
    for (const setting of [
      list(),
      { type: "text", label: "T", options: [{ value: "a", label: "A" }] },
      { type: "text", label: "T", default: "x" },
    ]) {
      const r = read({}, { s: setting });
      expect(r.ok).toBe(false);
    }
    expect(read({}, { s: { type: "text", label: "T" } }).ok).toBe(true);
  });
});
