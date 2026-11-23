// What a plugin may declare about the personal data it keeps (spec 18, section 5): where it is, which fields hold an email
// address, and what to show. Anything else is refused in plain words, and the plugin file carries the declaration.
import { describe, expect, test } from "vitest";
import { makePluginFile, readPluginFile } from "./plugin-file.js";
import { readPersonalData } from "./personal-data.js";

const one = (over: Record<string, unknown> = {}) => ({
  id: "form-messages",
  label: "Form messages",
  source: "storage:messages",
  match: ["emails"],
  show: [
    { field: "at", label: "Received", format: "datetime" },
    { field: "title", label: "Form" },
  ],
  ...over,
});

describe("personal data a plugin declares", () => {
  test("a collection, the fields that hold an address and what to show are read; the rest is dropped", () => {
    const r = readPersonalData([one({ script: "alert(1)" })]);
    expect(typeof r).toBe("object");
    if (typeof r === "string") return;
    expect(r[0]).toEqual({
      id: "form-messages",
      label: "Form messages",
      source: "storage:messages",
      match: ["emails"],
      show: [
        { field: "at", label: "Received", format: "datetime" },
        { field: "title", label: "Form" },
      ],
    });
  });

  test("when nothing is said to show, the time the item was saved is shown", () => {
    const r = readPersonalData([one({ show: undefined })]);
    expect(Array.isArray(r) && r[0]!.show).toEqual([
      { field: "$updatedAt", label: "Saved", format: "datetime" },
    ]);
  });

  test.each([
    ["not a list", { id: "x" }],
    ["six kinds", Array.from({ length: 6 }, (_, i) => one({ id: `p${i}` }))],
    ["an id twice", [one(), one()]],
    ["a bad id", [one({ id: "Bad Id" })]],
    ["no label", [one({ label: "" })]],
    ["a source that is not storage", [one({ source: "route:stats" })]],
    ["a source with a path out", [one({ source: "storage:../x" })]],
    ["no email fields", [one({ match: [] })]],
    ["four email fields", [one({ match: ["a", "b", "c", "d"] })]],
    ["an email field that is a call", [one({ match: ["a()"] })]],
    ["an email field that is the key", [one({ match: ["$key"] })]],
    ["an email field that is not text", [one({ match: [1] })]],
    [
      "seven fields to show",
      [one({ show: Array.from({ length: 7 }, () => ({ field: "a", label: "A" })) })],
    ],
    ["a field to show without a label", [one({ show: [{ field: "a" }] })]],
    ["a format that is not known", [one({ show: [{ field: "a", label: "A", format: "html" }] })]],
  ])("%s is refused in plain words", (_name, value) => {
    expect(typeof readPersonalData(value)).toBe("string");
  });

  test("a plugin file carries the declaration, and refuses a broken one", () => {
    const manifest = {
      id: "pd-demo",
      version: "1.0.0",
      displayName: "Demo",
      description: "d",
      author: "a",
      permissions: [],
      hooks: [],
      blocks: [],
      personalData: readPersonalData([one()]) as never,
    };
    const ok = readPluginFile(JSON.stringify(makePluginFile(manifest, "export default {};")));
    expect(ok.ok && ok.file.manifest.personalData?.[0]?.id).toBe("form-messages");
    const bad = readPluginFile(
      JSON.stringify(
        makePluginFile({ ...manifest, personalData: [{ id: "x" }] as never }, "export default {};"),
      ),
    );
    expect(bad.ok).toBe(false);
  });
});
