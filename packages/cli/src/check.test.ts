// PL-41: `oks check` catches a plugin that works in development but fails in the production build, and a plugin that
// uses a permission it did not declare. Each test writes a small plugin to a folder and checks it for real, with the
// production build and the real sandbox.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkPlugin, formatCheck } from "./check.js";
import { runCli } from "./main.js";

const T = 60_000;
const plugin = (
  source: string,
  manifest: Record<string, unknown> = {},
  files: Record<string, string> = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "oks-check-test-"));
  const put = (name: string, text: string) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  put(
    "package.json",
    JSON.stringify({
      name: "my-plugin",
      version: "1.0.0",
      oksPage: {
        type: "plugin",
        id: "my-plugin",
        permissions: ["content:read"],
        hooks: ["content:afterSave"],
        blocks: [],
        ...manifest,
      },
    }),
  );
  put("src/index.js", source);
  for (const [name, text] of Object.entries(files)) put(name, text);
  return dir;
};
const errors = (r: Awaited<ReturnType<typeof checkPlugin>>) =>
  r.issues.filter((i) => i.level === "error");
const GOOD = `export default { hooks: { "content:afterSave": async (e, ctx) => ({ title: (await ctx.content.get("sample")).title }) } };`;

describe("PL-41 oks check", () => {
  test(
    "PL-41 a good plugin passes, and the report says so with the bundle size",
    async () => {
      const r = await checkPlugin(plugin(GOOD), {});
      expect(r.issues).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.bundleBytes).toBeGreaterThan(0);
      expect(formatCheck(r)).toMatch(
        /^ok {4}The plugin passed the check\. Production bundle: \d+ bytes\.$/,
      );
    },
    T,
  );

  test(
    "PL-41 a folder with no oksPage section fails with what to add",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "oks-check-test-"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
      const r = await checkPlugin(dir);
      expect(r.ok).toBe(false);
      expect(errors(r)[0]!.message).toMatch(/no "oksPage" section/);
    },
    T,
  );

  test(
    "PL-41 an import that cannot be found in the production build fails the check",
    async () => {
      const r = await checkPlugin(
        plugin(
          `import { helper } from "./missing.js";\nexport default { hooks: { "content:afterSave": async () => helper() } };`,
        ),
      );
      expect(r.ok).toBe(false);
      expect(errors(r)[0]).toMatchObject({ code: "build" });
      expect(errors(r)[0]!.message).toMatch(/production build failed/);
    },
    T,
  );

  test(
    "PL-41 a plugin that uses Node's own modules works in development but fails the check",
    async () => {
      const r = await checkPlugin(
        plugin(
          `import { readFileSync } from "node:fs";\nexport default { hooks: { "content:afterSave": async () => readFileSync("/etc/hostname", "utf8") } };`,
        ),
      );
      expect(r.ok).toBe(false);
      expect(errors(r)[0]!.message).toMatch(
        /cannot use "node:fs".*without Node\.js.*fail on a site/,
      );
    },
    T,
  );

  test(
    "PL-41 building code from text fails the check",
    async () => {
      const r = await checkPlugin(
        plugin(`export default { hooks: { "content:afterSave": async (e) => eval("1+1") } };`),
      );
      expect(errors(r)[0]).toMatchObject({ code: "code-generation" });
    },
    T,
  );

  test(
    "PL-41 a bundle over the size limit fails the check",
    async () => {
      const r = await checkPlugin(plugin(GOOD), { maxBytes: 50 });
      expect(r.ok).toBe(false);
      expect(errors(r)[0]).toMatchObject({ code: "size" });
    },
    T,
  );

  test(
    "PL-41 a hook in the code that the manifest does not list fails, and so does a listed hook that is missing",
    async () => {
      const extra = await checkPlugin(plugin(GOOD, { hooks: [] }));
      expect(errors(extra).map((e) => e.message)).toEqual([
        'The code has the hook "content:afterSave" but "oksPage.hooks" does not list it.',
      ]);
      const missing = await checkPlugin(
        plugin(GOOD, { hooks: ["content:afterSave", "content:beforeSave"] }),
      );
      expect(errors(missing).map((e) => e.message)).toEqual([
        '"oksPage.hooks" lists "content:beforeSave" but the code does not have it.',
      ]);
    },
    T,
  );

  test(
    "PL-41 a block in the code that the manifest does not list fails",
    async () => {
      const r = await checkPlugin(
        plugin(
          `export default { blocks: { "my-card": { render: async () => ({ type: "paragraph", props: {}, content: [], children: [] }) } } };`,
          { hooks: [] },
        ),
      );
      expect(errors(r).map((e) => e.message)).toEqual([
        'The code has the block "my-card" but "oksPage.blocks" does not list it.',
      ]);
    },
    T,
  );

  test(
    "PL-41 routes: the manifest and the code must agree, and routes need routes:public",
    async () => {
      const source = `export default { routes: { send: async () => ({ json: 1 }) } };`;
      const routes = { send: { method: "POST" } };
      const good = await checkPlugin(
        plugin(source, { hooks: [], permissions: ["routes:public"], routes }),
      );
      expect(good.issues).toEqual([]);
      const unlisted = await checkPlugin(
        plugin(source, { hooks: [], permissions: ["routes:public"] }),
      );
      expect(errors(unlisted).map((e) => e.message)).toEqual([
        'The code has the route "send" but "oksPage.routes" does not list it.',
      ]);
      const missing = await checkPlugin(
        plugin(`export default {};`, {
          hooks: [],
          permissions: ["routes:public"],
          routes,
        }),
      );
      expect(errors(missing).map((e) => e.message)).toEqual([
        '"oksPage.routes" lists "send" but the code does not have it.',
      ]);
      const noPermission = await checkPlugin(plugin(source, { hooks: [], routes }));
      expect(errors(noPermission).map((e) => e.message)).toContain(
        'A plugin with routes must list "routes:public" in "permissions".',
      );
    },
    T,
  );

  test(
    "PL-72 admin pages: the pages are checked like a plugin file does, and need admin:pages",
    async () => {
      const adminPages = [
        {
          id: "items",
          title: "Items",
          view: { type: "table", source: "storage:items", columns: [{ field: "a", label: "A" }] },
        },
      ];
      const good = await checkPlugin(
        plugin(`export default {};`, { hooks: [], permissions: ["admin:pages"], adminPages }),
      );
      expect(good.issues).toEqual([]);
      const noPermission = await checkPlugin(
        plugin(`export default {};`, { hooks: [], adminPages }),
      );
      expect(errors(noPermission).map((e) => e.message)).toContain(
        'A plugin with admin pages must list "admin:pages" in "permissions".',
      );
      const broken = await checkPlugin(
        plugin(`export default {};`, {
          hooks: [],
          permissions: ["admin:pages"],
          adminPages: [{ id: "items", title: "Items", view: { type: "chart" } }],
        }),
      );
      expect(errors(broken)[0]?.message).toContain('"oksPage.adminPages"');
    },
    T,
  );

  test(
    "PL-73 jobs: the manifest and the code must agree, and an interval must be from 5 minutes to 7 days",
    async () => {
      const source = `export default { jobs: { keep: async () => {} } };`;
      const jobs = { keep: { everyMinutes: 1440 } };
      const good = await checkPlugin(plugin(source, { hooks: [], jobs }));
      expect(good.issues).toEqual([]);
      const unlisted = await checkPlugin(plugin(source, { hooks: [] }));
      expect(errors(unlisted).map((e) => e.message)).toEqual([
        'The code has the job "keep" but "oksPage.jobs" does not list it.',
      ]);
      const missing = await checkPlugin(plugin(`export default {};`, { hooks: [], jobs }));
      expect(errors(missing).map((e) => e.message)).toEqual([
        '"oksPage.jobs" lists "keep" but the code does not have it.',
      ]);
      const tooOften = await checkPlugin(
        plugin(source, { hooks: [], jobs: { keep: { everyMinutes: 1 } } }),
      );
      expect(errors(tooOften)[0]?.message).toContain('"oksPage.jobs"');
    },
    T,
  );

  test(
    "PL-41 a plugin that uses a permission it did not declare fails, naming the hook and the exact permission",
    async () => {
      const source = `export default { hooks: { "content:afterSave": async (e, ctx) => { await ctx.content.update("sample", { title: "changed" }); return e; } } };`;
      const r = await checkPlugin(plugin(source));
      expect(r.ok).toBe(false);
      expect(errors(r)).toHaveLength(1);
      expect(errors(r)[0]).toMatchObject({ code: "permission" });
      expect(errors(r)[0]!.message).toMatch(
        /Hook "content:afterSave" needs "content:write"\. Add it to "permissions" in the manifest/,
      );
      // The same plugin passes once the permission is declared.
      const fixed = await checkPlugin(
        plugin(source, { permissions: ["content:read", "content:write"] }),
      );
      expect(fixed.issues).toEqual([]);
    },
    T,
  );

  test(
    "PL-41 a hook that stops with an error on sample data is a warning, not a failure",
    async () => {
      const r = await checkPlugin(
        plugin(
          `export default { hooks: { "content:afterSave": async (e) => { throw new Error("needs real data"); } } };`,
        ),
      );
      expect(r.ok).toBe(true);
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]).toMatchObject({ level: "warning", code: "sample" });
      expect(r.issues[0]!.message).toMatch(/needs real data/);
    },
    T,
  );

  test(
    "PL-41 a hook that never ends fails the check",
    async () => {
      const r = await checkPlugin(
        plugin(`export default { hooks: { "content:afterSave": async () => { for (;;) {} } } };`),
      );
      expect(errors(r)[0]).toMatchObject({ code: "timeout" });
    },
    T,
  );

  test(
    "PL-41 a build-time plugin is trusted code: it passes with a warning that it was not run in the sandbox",
    async () => {
      const r = await checkPlugin(plugin(GOOD, { runtime: "build" }));
      expect(r.ok).toBe(true);
      expect(r.issues[0]).toMatchObject({ level: "warning", code: "runtime" });
    },
    T,
  );

  test(
    "PL-41 the command prints the report and exits 0 when it passes, 1 when it fails, 2 when it is not understood",
    async () => {
      const lines: string[] = [];
      expect(await runCli(["check", plugin(GOOD)], (t) => lines.push(t))).toBe(0);
      expect(lines.at(-1)).toMatch(/passed the check/);
      expect(
        await runCli(["check", plugin(`import "node:fs";\nexport default {};`)], (t) =>
          lines.push(t),
        ),
      ).toBe(1);
      expect(lines.at(-1)).toMatch(/did not pass the check/);
      expect(await runCli(["frobnicate"], (t) => lines.push(t))).toBe(2);
      expect(lines.at(-1)).toMatch(/Usage: oks check/);
    },
    T,
  );
});
