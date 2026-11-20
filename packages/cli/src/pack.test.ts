// `oks pack`: the one file an owner uploads is made only from a plugin that passes `oks check`, and it reads back whole.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readPluginFile } from "@oks-page/sandbox";
import { describe, expect, test } from "vitest";
import { runCli } from "./main.js";
import { packPlugin } from "./pack.js";

const T = 60_000;
const GOOD = `export default { hooks: { "content:afterSave": async (e, ctx) => ({ title: (await ctx.content.get("sample")).title }) } };`;
const plugin = (oksPage: Record<string, unknown> = {}, source = GOOD) => {
  const dir = mkdtempSync(join(tmpdir(), "oks-pack-test-"));
  const put = (name: string, text: string) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  put(
    "package.json",
    JSON.stringify({
      name: "my-plugin",
      version: "1.0.0",
      description: "Shows the title.",
      author: "Ada <ada@example.com>",
      oksPage: {
        type: "plugin",
        id: "my-plugin",
        displayName: "My plugin",
        permissions: ["content:read"],
        hooks: ["content:afterSave"],
        blocks: [],
        ...oksPage,
      },
    }),
  );
  put("src/index.js", source);
  return dir;
};

describe("oks pack", () => {
  test(
    "a good plugin is packed into one file that reads back with its manifest and bundle",
    async () => {
      const dir = plugin();
      const lines: string[] = [];
      expect(await runCli(["pack", dir], (t) => lines.push(t))).toBe(0);
      expect(lines.join("\n")).toMatch(
        /Wrote .*my-plugin-1\.0\.0\.oksplugin\. Upload it in Tools > Plugins\./,
      );
      const r = readPluginFile(readFileSync(join(dir, "my-plugin-1.0.0.oksplugin"), "utf8"));
      expect(r.ok && r.file.manifest).toMatchObject({
        id: "my-plugin",
        version: "1.0.0",
        displayName: "My plugin",
        description: "Shows the title.",
        author: "Ada",
        permissions: ["content:read"],
        hooks: ["content:afterSave"],
      });
      expect(r.ok && r.file.code.length).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "--out chooses the file, and a plugin that fails the check is not packed",
    async () => {
      const dir = plugin();
      const out = join(dir, "custom.oksplugin");
      expect(await runCli(["pack", dir, "--out", out], () => undefined)).toBe(0);
      expect(readPluginFile(readFileSync(out, "utf8")).ok).toBe(true);
      // Uses a permission it did not declare: the check fails, so no file is written.
      const broken = plugin({ permissions: [] });
      const result = await packPlugin(broken);
      expect(result.ok).toBe(false);
      expect(result.report).toMatch(/FAIL/);
      expect(result.file).toBeUndefined();
    },
    T,
  );

  test(
    "a build-time plugin has no plugin file",
    async () => {
      const result = await packPlugin(plugin({ runtime: "build" }));
      expect(result.ok).toBe(false);
      expect(result.report).toMatch(/build-time plugin has no plugin file/);
    },
    T,
  );
});
