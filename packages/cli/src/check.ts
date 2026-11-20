// `oks check` for a plugin (spec 04, section 11; PL-41): build the production bundle, check it against the manifest and
// run it in the real sandbox, so a plugin that works in development and fails in the build is caught before it is
// published. It reports plain sentences, each with what to do.
import { newId } from "@oks-page/db";
import { openMemoryDatabase } from "@oks-page/db/memory";
import { SandboxHost } from "@oks-page/sandbox";
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findReactCopies } from "./react-copies.js";

export interface CheckIssue {
  level: "error" | "warning";
  /** A short name for the kind of problem, for tools. */
  code: string;
  message: string;
}

export interface CheckResult {
  /** True when there is no error. Warnings do not fail a check. */
  ok: boolean;
  issues: CheckIssue[];
  /** The size of the production bundle, when it could be built. */
  bundleBytes?: number;
  /** The production bundle, when the check passed (`oks pack` writes it into the plugin file). */
  code?: string;
}

export interface CheckOptions {
  /** The largest production bundle allowed. Default 1 MB. */
  maxBytes?: number;
}

const MAX_BYTES = 1_000_000;
const ID = /^[a-z0-9-]{3,40}$/;
const SAMPLE_ENTRY = { id: "sample", title: "Sample", plainText: "one two three", meta: {} };

interface Manifest {
  id: string;
  version: string;
  runtime: string;
  permissions: string[];
  hooks: string[];
  blocks: string[];
  entry: string | null;
}

const strings = (v: unknown): string[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;

export async function checkPlugin(dir: string, options: CheckOptions = {}): Promise<CheckResult> {
  const issues: CheckIssue[] = [];
  const add = (level: CheckIssue["level"], code: string, message: string) =>
    issues.push({ level, code, message });
  const result = (extra: Partial<CheckResult> = {}): CheckResult => ({
    ok: !issues.some((i) => i.level === "error"),
    issues,
    ...extra,
  });
  const root = resolve(dir);

  // 1. The manifest, in package.json under "oksPage" (spec 04, section 3).
  const pkgFile = join(root, "package.json");
  if (!existsSync(pkgFile)) {
    add("error", "manifest", `There is no package.json in ${root}.`);
    return result();
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, unknown>;
  } catch {
    add("error", "manifest", "package.json is not valid JSON.");
    return result();
  }
  const raw = pkg["oksPage"] as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") {
    add(
      "error",
      "manifest",
      'package.json has no "oksPage" section. Add one with the plugin\'s id and permissions.',
    );
    return result();
  }
  const permissions = strings(raw["permissions"]);
  const hooks = strings(raw["hooks"]);
  const blocks = strings(raw["blocks"]);
  if (raw["type"] !== "plugin")
    add("error", "manifest", '"oksPage.type" must be "plugin". Themes are checked separately.');
  if (typeof raw["id"] !== "string" || !ID.test(raw["id"]))
    add("error", "manifest", '"oksPage.id" must be 3 to 40 lower-case letters, digits or hyphens.');
  if (typeof pkg["version"] !== "string" || !/^\d+\.\d+\.\d+/.test(pkg["version"]))
    add("error", "manifest", 'package.json needs a "version" such as 1.0.0.');
  if (!permissions || !hooks || !blocks)
    add(
      "error",
      "manifest",
      '"permissions", "hooks" and "blocks" in "oksPage" must each be a list of text.',
    );
  if (issues.length > 0) return result();
  const manifest: Manifest = {
    id: raw["id"] as string,
    version: pkg["version"] as string,
    runtime: typeof raw["runtime"] === "string" ? raw["runtime"] : "sandbox",
    permissions: permissions!,
    hooks: hooks!,
    blocks: blocks!,
    entry: typeof raw["entry"] === "string" ? raw["entry"] : null,
  };
  if (manifest.runtime === "build") {
    // Trusted code that runs inside the site: it must use the admin's React, not bring its own (AD-47).
    const own = findReactCopies(root);
    if (own.length > 0)
      add(
        "error",
        "react-copy",
        `This plugin has its own copy of React (${own[0]!.path}). Two copies of React in one page make it crash. Move react to peerDependencies and remove it from this plugin's own node_modules.`,
      );
    add(
      "warning",
      "runtime",
      "This is a build-time plugin. It is trusted code that runs inside the site, so it is not run in the sandbox here.",
    );
    return result();
  }
  if (manifest.runtime !== "sandbox") {
    add(
      "error",
      "manifest",
      `"oksPage.runtime" must be "sandbox" or "build", not "${manifest.runtime}".`,
    );
    return result();
  }

  // 2. The production bundle, built the way a site will run it: one file, no Node-only modules.
  const entry = [manifest.entry, "src/index.ts", "src/index.js", "index.ts", "index.js"]
    .filter((e): e is string => Boolean(e))
    .map((e) => join(root, e))
    .find((e) => existsSync(e));
  if (!entry) {
    add(
      "error",
      "build",
      'The plugin\'s entry file was not found. Set "oksPage.entry" or add src/index.ts.',
    );
    return result();
  }
  let code: string;
  try {
    const out = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      minify: true,
      logLevel: "silent",
      absWorkingDir: root,
      define: { "process.env.NODE_ENV": '"production"' },
    });
    code = out.outputFiles[0]!.text;
  } catch (e) {
    const errors = (e as { errors?: { text: string }[] }).errors ?? [
      { text: String((e as Error).message) },
    ];
    for (const err of errors) {
      const node =
        /Could not resolve "(node:[^"]+|fs|path|os|child_process|net|http|https|crypto)"/.exec(
          err.text,
        );
      add(
        "error",
        "build",
        node
          ? `The production build cannot use "${node[1]}": a sandboxed plugin runs without Node.js. It may work in development but it will fail on a site.`
          : `The production build failed: ${err.text}`,
      );
    }
    return result();
  }
  const bundleBytes = Buffer.byteLength(code);
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (bundleBytes > maxBytes)
    add(
      "error",
      "size",
      `The production bundle is ${bundleBytes} bytes; the most allowed is ${maxBytes}. Remove what the plugin does not need.`,
    );
  if (/\beval\s*\(|new\s+Function\s*\(/.test(code))
    add(
      "error",
      "code-generation",
      "The code builds code from text (eval or new Function). The sandbox does not allow that.",
    );
  if (issues.some((i) => i.level === "error")) return result({ bundleBytes });

  // 3. Run it in the real sandbox, with the permissions it declares and nothing more.
  const db = openMemoryDatabase();
  const siteId = newId();
  const extensionId = newId();
  const now = new Date();
  const store = new Map([[SAMPLE_ENTRY.id, { ...SAMPLE_ENTRY, status: "published" }]]);
  const host = new SandboxHost({
    runner: db.runner,
    siteId,
    content: {
      get: async (id) => store.get(id) ?? null,
      update: async (id, patch) => {
        const e = store.get(id);
        if (!e) return null;
        Object.assign(e, patch);
        return e;
      },
    },
    workDir: mkdtempSync(join(tmpdir(), "oks-check-")),
    wallMs: 2000,
    onDeveloperNote: () => undefined,
  });
  try {
    await db.runner.all(
      `insert into "sites" ("id", "name", "created_at", "updated_at") values (?, 'check', ?, ?)`,
      [siteId, now, now],
    );
    await db.runner.all(
      `insert into "extensions" ("id", "site_id", "key", "kind", "version", "tier", "installed_at") values (?, ?, ?, 'plugin', ?, 'runtime', ?)`,
      [extensionId, siteId, manifest.id, manifest.version, now],
    );
    await host.listen();
    host.load(
      { id: manifest.id, version: manifest.version, permissions: manifest.permissions },
      code,
      extensionId,
    );
    let shape: { hooks: string[]; blocks: string[] } | null;
    try {
      shape = await host.describe(manifest.id);
    } catch (e) {
      add(
        "error",
        "start",
        `The plugin did not start in the sandbox: ${String((e as Error).message).slice(0, 200)}`,
      );
      return result({ bundleBytes });
    }
    if (!shape) {
      add("error", "start", "The plugin did not start in the sandbox.");
      return result({ bundleBytes });
    }
    // The manifest and the code must agree: the site uses the manifest and never has to run the code to know.
    for (const h of shape.hooks)
      if (!manifest.hooks.includes(h))
        add(
          "error",
          "manifest-mismatch",
          `The code has the hook "${h}" but "oksPage.hooks" does not list it.`,
        );
    for (const h of manifest.hooks)
      if (!shape.hooks.includes(h))
        add(
          "error",
          "manifest-mismatch",
          `"oksPage.hooks" lists "${h}" but the code does not have it.`,
        );
    for (const b of shape.blocks)
      if (!manifest.blocks.includes(b))
        add(
          "error",
          "manifest-mismatch",
          `The code has the block "${b}" but "oksPage.blocks" does not list it.`,
        );
    for (const b of manifest.blocks)
      if (!shape.blocks.includes(b))
        add(
          "error",
          "manifest-mismatch",
          `"oksPage.blocks" lists "${b}" but the code does not have it.`,
        );

    // Every hook and block runs once with sample data. A refusal means it uses a permission it did not declare.
    const seen = new Set<string>();
    const run = async (kind: "hook" | "block", name: string) => {
      const r = await host.call(manifest.id, kind, name, kind === "hook" ? SAMPLE_ENTRY : {});
      for (const refusal of r.permissionRefusals ?? []) {
        if (seen.has(refusal.permission)) continue;
        seen.add(refusal.permission);
        add(
          "error",
          "permission",
          `${refusal.message} (found when running the ${kind} "${name}").`,
        );
      }
      if (!r.ok && r.error === "timeout")
        add(
          "error",
          "timeout",
          `The ${kind} "${name}" took longer than the time allowed in the sandbox.`,
        );
      else if (!r.ok && !r.permissionRefusals?.length && !r.skipped)
        add(
          "warning",
          "sample",
          `The ${kind} "${name}" stopped with an error when run with sample data: ${r.error}. If it needs real data, this is fine.`,
        );
    };
    for (const h of shape.hooks) await run("hook", h);
    for (const b of shape.blocks) await run("block", b);
    return result({ bundleBytes, code });
  } finally {
    await host.close();
    db.close();
  }
}

/** The report `oks check` prints. */
export function formatCheck(result: CheckResult): string {
  const lines = result.issues.map((i) => `${i.level === "error" ? "FAIL" : "warn"}  ${i.message}`);
  const size =
    result.bundleBytes === undefined ? "" : ` Production bundle: ${result.bundleBytes} bytes.`;
  lines.push(
    result.ok
      ? `ok    The plugin passed the check.${size}`
      : `FAIL  The plugin did not pass the check.${size}`,
  );
  return lines.join("\n");
}
