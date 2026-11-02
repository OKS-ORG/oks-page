// `oks export` preflight (spec 10, sections 4 and 5; ST-30). Next.js builds some broken exports without any error: a proxy
// file is silently dropped, and next/image with its default loader writes addresses a static host does not have. So the
// checks run before the build and stop it with a plain sentence for each problem.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CheckIssue } from "./check.js";

export type BlockStatic = "yes" | "helper" | "no" | undefined;

export interface ExportCheckOptions {
  /** Folders under src/app that are not part of the exported site (they need a server). Default: admin and api. */
  serverOnly?: string[];
  /** For each block the site uses: does it work on a static site? */
  blocks?: Record<string, BlockStatic>;
  /** Blocks of the kind "helper" that already have their helper set (for example a form with an address). */
  helpersSet?: string[];
}

export interface ExportCheckResult {
  ok: boolean;
  issues: CheckIssue[];
}

const CODE = /\.(?:[cm]?[jt]sx?)$/;

function files(dir: string, skip: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip(path)) continue;
    if (statSync(path).isDirectory()) found.push(...files(path, skip));
    else if (CODE.test(name)) found.push(path);
  }
  return found;
}

export function checkExport(siteDir: string, options: ExportCheckOptions = {}): ExportCheckResult {
  const issues: CheckIssue[] = [];
  const error = (code: string, message: string) => issues.push({ level: "error", code, message });
  const warning = (code: string, message: string) =>
    issues.push({ level: "warning", code, message });
  const app = join(siteDir, "src", "app");
  const serverOnly = (options.serverOnly ?? ["admin", "api"]).map((name) => join(app, name));
  const inExport = (path: string) =>
    !serverOnly.some((dir) => path === dir || path.startsWith(dir + "/"));
  const name = (path: string) => relative(siteDir, path);

  // A proxy (or the older "middleware") file is dropped by the export without a word.
  for (const base of ["proxy", "middleware"])
    for (const folder of [siteDir, join(siteDir, "src")])
      for (const ext of ["ts", "js", "mjs"])
        if (existsSync(join(folder, `${base}.${ext}`)))
          error(
            "proxy-file",
            `${name(join(folder, `${base}.${ext}`))}: an exported site has no proxy, so every rule in it (redirects, 404 pages) would silently stop working. Move the rule into the redirect list, or leave this file out of the export.`,
          );

  const pages = files(app, (path) => !inExport(path));
  for (const path of pages) {
    const text = readFileSync(path, "utf8");
    const file = name(path);
    if (
      /from\s+["']next\/headers["']/.test(text) ||
      /\b(?:cookies|headers|draftMode)\s*\(/.test(text)
    )
      error(
        "request-data",
        `${file}: reads cookies, headers or Draft Mode. A page made ahead of time has no visitor to read them from.`,
      );
    if (/^\s*["']use server["']/m.test(text))
      error(
        "server-action",
        `${file}: has a Server Action. A static site has no server to run it. Use a form address instead.`,
      );
    if (/from\s+["']next\/image["']/.test(text))
      error(
        "image-default-loader",
        `${file}: uses next/image. Its default loader writes addresses that do not exist on a static host, so the pictures would be broken. Use a plain <img> with the sizes made at upload.`,
      );
    const isPage = /(?:^|\/)page\.[cm]?[jt]sx?$/.test(path);
    const dynamic = path.split("/").some((part) => /^\[.+\]$/.test(part));
    if (isPage && dynamic && !/generateStaticParams/.test(text))
      error(
        "no-static-params",
        `${file}: is a page with a changing address but does not say which addresses to write (generateStaticParams).`,
      );
    if (
      /(?:^|\/)route\.[cm]?[jt]sx?$/.test(path) &&
      !/dynamic\s*=\s*["']force-static["']/.test(text)
    )
      error(
        "route-not-static",
        `${file}: is a route handler that is not marked force-static, so it cannot be written as a file.`,
      );
  }

  // next/image is also fine when the whole site turns the optimiser off.
  const config = ["next.config.mjs", "next.config.js", "next.config.ts"]
    .map((f) => join(siteDir, f))
    .find(existsSync);
  if (config && /unoptimized\s*:\s*true/.test(readFileSync(config, "utf8"))) {
    for (let i = issues.length - 1; i >= 0; i--)
      if (issues[i]!.code === "image-default-loader") issues.splice(i, 1);
  }

  // Every block must say whether it works on a static site (spec 10, section 5).
  for (const [block, status] of Object.entries(options.blocks ?? {})) {
    if (status === "yes") continue;
    if (status === "helper") {
      if (!options.helpersSet?.includes(block))
        warning(
          "block-needs-helper",
          `The ${block} block needs a helper on a static site (for example a form address). Set it, or remove the block.`,
        );
    } else if (status === "no")
      error(
        "block-needs-server",
        `The ${block} block needs a server and cannot be part of a static site. Remove it, or publish in server mode.`,
      );
    else
      error("block-unknown", `The ${block} block does not say whether it works on a static site.`);
  }

  return { ok: !issues.some((i) => i.level === "error"), issues };
}

export function formatExportCheck(result: ExportCheckResult): string {
  if (result.issues.length === 0) return "The site can be exported. No problems found.";
  const lines = result.issues.map(
    (i) => `${i.level === "error" ? "Problem" : "Note"}: ${i.message}`,
  );
  lines.push(
    result.ok
      ? "The site can be exported, with the notes above."
      : "The export was stopped. Fix the problems above first.",
  );
  return lines.join("\n");
}
