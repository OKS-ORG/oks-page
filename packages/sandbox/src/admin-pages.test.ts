// The admin pages a plugin may describe (spec 04, section 9): what is accepted, what is refused in plain words, and that a
// plugin file with pages must ask for the permission.
import { describe, expect, test } from "vitest";
import { collectionOf, readAdminPages } from "./admin-pages.js";
import { makePluginFile, readPluginFile } from "./plugin-file.js";

const page = (view: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id: "messages",
  title: "Messages",
  view: {
    type: "table",
    source: "storage:messages",
    columns: [{ field: "at", label: "Received", format: "datetime" }],
    ...view,
  },
  ...extra,
});

describe("admin pages of plugins", () => {
  test("a table over the plugin's storage is read, and what is not known is dropped", () => {
    const r = readAdminPages([
      page({
        order: "asc",
        filters: [{ label: "New", field: "status", value: "new" }],
        actions: [
          {
            id: "read",
            label: "Read",
            kind: "set",
            field: "status",
            value: "read",
            run: "alert(1)",
          },
          { id: "delete", label: "Delete", kind: "delete", confirm: false },
        ],
        export: true,
        script: "alert(1)",
      }),
    ]);
    expect(typeof r).toBe("object");
    if (typeof r === "string") return;
    expect(r[0]!.view.order).toBe("asc");
    expect(r[0]!.view.actions).toEqual([
      { id: "read", label: "Read", kind: "set", field: "status", value: "read" },
      // A delete always asks first, whatever the plugin says.
      { id: "delete", label: "Delete", kind: "delete", confirm: true },
    ]);
    expect(JSON.stringify(r)).not.toContain("alert");
    expect(collectionOf("storage:messages")).toBe("messages");
    expect(collectionOf("route:stats")).toBeNull();
    expect(collectionOf("storage:../x")).toBeNull();
  });

  test.each([
    ["not a list", { id: "x" }],
    ["six pages", Array.from({ length: 6 }, (_, i) => page({}, { id: `p${i}` }))],
    ["an id twice", [page(), page()]],
    ["a bad id", [page({}, { id: "Bad Id" })]],
    ["no title", [page({}, { title: "" })]],
    ["another view type", [page({ type: "chart" })]],
    ["a source that is not storage", [page({ source: "route:stats" })]],
    ["no columns", [page({ columns: [] })]],
    [
      "nine columns",
      [page({ columns: Array.from({ length: 9 }, () => ({ field: "a", label: "A" })) })],
    ],
    [
      "a column field with a path out of the item",
      [page({ columns: [{ field: "a..b", label: "A" }] })],
    ],
    ["a column field that is a call", [page({ columns: [{ field: "a()", label: "A" }] })]],
    [
      "a format that is not known",
      [page({ columns: [{ field: "a", label: "A", format: "html" }] })],
    ],
    [
      "a truncate that is too small",
      [page({ columns: [{ field: "a", label: "A", truncate: 2 }] })],
    ],
    ["a filter without a value", [page({ filters: [{ label: "New", field: "status" }] })]],
    [
      "five actions",
      [
        page({
          actions: Array.from({ length: 5 }, (_, i) => ({
            id: `a${i}`,
            label: "A",
            kind: "delete",
          })),
        }),
      ],
    ],
    ["an action that runs code", [page({ actions: [{ id: "a", label: "A", kind: "run" }] })]],
    [
      "an action twice",
      [
        page({
          actions: [
            { id: "a", label: "A", kind: "delete" },
            { id: "a", label: "B", kind: "delete" },
          ],
        }),
      ],
    ],
    [
      "a set that changes a path",
      [page({ actions: [{ id: "a", label: "A", kind: "set", field: "a.b", value: "x" }] })],
    ],
    [
      "a set without a value",
      [page({ actions: [{ id: "a", label: "A", kind: "set", field: "a" }] })],
    ],
    ["an export that is not true or false", [page({ export: "yes" })]],
  ])("%s is refused in plain words", (_name, value) => {
    const r = readAdminPages(value);
    expect(typeof r).toBe("string");
  });

  test("a plugin file with admin pages must ask for admin:pages", () => {
    const manifest = {
      id: "demo-pages",
      version: "1.0.0",
      displayName: "Demo",
      description: "d",
      author: "a",
      permissions: ["admin:pages"],
      hooks: [],
      blocks: [],
      adminPages: readAdminPages([page()]) as never,
    };
    const ok = readPluginFile(JSON.stringify(makePluginFile(manifest, "export default {};")));
    expect(ok.ok && ok.file.manifest.adminPages?.[0]?.title).toBe("Messages");
    const without = readPluginFile(
      JSON.stringify(makePluginFile({ ...manifest, permissions: [] }, "export default {};")),
    );
    expect(without.ok).toBe(false);
    expect(!without.ok && without.message).toContain("admin:pages");
    const bad = readPluginFile(
      JSON.stringify(
        makePluginFile({ ...manifest, adminPages: [{ id: "x" }] as never }, "export default {};"),
      ),
    );
    expect(bad.ok).toBe(false);
  });
});
