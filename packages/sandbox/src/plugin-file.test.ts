// The plugin file (spec 04, sections 3 and 10): made once, read back with every part checked.
import { describe, expect, test } from "vitest";
import { makePluginFile, readPluginFile, type PluginFileManifest } from "./plugin-file.js";

const manifest: PluginFileManifest = {
  id: "reading-time",
  version: "1.2.0",
  displayName: "Reading time",
  description: "Shows how long a post takes to read.",
  author: "Ada",
  permissions: ["content:read", "network:fetch:api.example.com"],
  hooks: ["content:beforeSave"],
  blocks: [],
};
const CODE = "export default { hooks: {} };";

const withManifest = (m: Partial<Record<keyof PluginFileManifest, unknown>>) =>
  readPluginFile(
    JSON.stringify(makePluginFile({ ...manifest, ...(m as object) } as PluginFileManifest, CODE)),
  );

describe("the plugin file", () => {
  test("a file made by makePluginFile reads back whole", () => {
    const r = readPluginFile(JSON.stringify(makePluginFile(manifest, CODE)));
    expect(r.ok && r.file.manifest).toEqual(manifest);
    expect(r.ok && r.file.code).toBe(CODE);
  });

  test("a file that is not JSON, not an object or from another format is refused in plain words", () => {
    for (const text of ["", "not json", "[]", "null", '{"format": 9}'])
      expect(readPluginFile(text)).toMatchObject({ ok: false });
    expect(readPluginFile("nope")).toEqual({
      ok: false,
      message: "This is not a plugin file. Make one with `oks pack`.",
    });
  });

  test("code that was changed after the file was made does not match its hash (PL-23)", () => {
    const file = {
      ...makePluginFile(manifest, CODE),
      code: "export default { hooks: { evil: 1 } };",
    };
    const r = readPluginFile(JSON.stringify(file));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toMatch(/changed after it was made/);
    expect(readPluginFile(JSON.stringify({ ...file, code: "" }))).toMatchObject({ ok: false });
  });

  test("a bad id, version, permission, hook, block or setting is refused", () => {
    expect(withManifest({ id: "A" })).toMatchObject({ ok: false });
    expect(withManifest({ id: "../x" })).toMatchObject({ ok: false });
    expect(withManifest({ version: "one" })).toMatchObject({ ok: false });
    expect(withManifest({ permissions: ["root:everything"] })).toMatchObject({ ok: false });
    expect(withManifest({ permissions: ["network:fetch:localhost"] })).toMatchObject({ ok: false });
    expect(withManifest({ permissions: ["content:read", "content:read"] })).toMatchObject({
      ok: false,
    });
    expect(withManifest({ hooks: ["not a hook"] })).toMatchObject({ ok: false });
    expect(withManifest({ blocks: ["Bad Block"] })).toMatchObject({ ok: false });
    expect(withManifest({ description: "x".repeat(301) })).toMatchObject({ ok: false });
    expect(withManifest({ author: undefined })).toMatchObject({ ok: false });
    expect(withManifest({ priority: 500 })).toMatchObject({ ok: false });
    expect(withManifest({ settings: { "Bad Key": { type: "text" } } })).toMatchObject({
      ok: false,
    });
    expect(withManifest({ settings: { key: { type: "file" } } })).toMatchObject({ ok: false });
  });

  test("settings and a priority are kept; a plugin with no display name is shown by its id", () => {
    const settings = { api_key: { type: "secret" as const, label: "API key" } };
    const r = withManifest({ priority: 5, settings });
    expect(r.ok && r.file.manifest.priority).toBe(5);
    expect(r.ok && r.file.manifest.settings).toEqual(settings);
    const noName = withManifest({ displayName: undefined });
    expect(noName.ok && noName.file.manifest.displayName).toBe("reading-time");
  });

  test("a file bigger than the limit is refused", () => {
    expect(readPluginFile(" ".repeat(5 * 1024 * 1024 + 1))).toMatchObject({ ok: false });
  });
});
