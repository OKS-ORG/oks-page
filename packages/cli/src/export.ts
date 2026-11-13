// `oks export` (spec 10; S6): check the site, build the pages as plain files, then add the redirect files.
import { buildRedirectFiles, type Redirect, type RefusedRedirect } from "@oks-page/seo";
import * as pagefind from "pagefind";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { checkExport, type ExportCheckOptions, type ExportCheckResult } from "./export-check.js";

export interface ExportOptions extends ExportCheckOptions {
  /** The folder for the exported site. Default: `out` inside the site folder. */
  out?: string;
  /** The redirects to write into the export. */
  redirects?: Redirect[];
  /** Builds the pages into `out`. The default runs the site's own `scripts/build-export.mjs`. Tests pass their own. */
  build?: (siteDir: string, out: string) => Promise<void>;
  /** The folder of uploaded files and their sizes, copied as it is to `uploads` in the export. */
  uploads?: string;
  /** Makes the search index in `out`. The default runs Pagefind. Tests pass their own. */
  search?: (out: string) => Promise<void>;
}

export interface ExportResult {
  ok: boolean;
  check: ExportCheckResult;
  out: string;
  /** The files written by this step (redirects), relative to `out`. */
  written: string[];
  refusedRedirects: RefusedRedirect[];
  /** Problems found in the finished export, as plain sentences. */
  problems: string[];
}

async function runSiteBuild(siteDir: string, out: string): Promise<void> {
  const script = join(siteDir, "scripts", "build-export.mjs");
  if (!existsSync(script))
    throw new Error(`${script} was not found, so this folder cannot be exported.`);
  await promisify(execFile)(process.execPath, [script, out], {
    cwd: siteDir,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Indexes the built pages. Only the content marked `data-pagefind-body` is searched, so menus and footers are left out. */
async function runPagefind(out: string): Promise<void> {
  const { index, errors } = await pagefind.createIndex();
  try {
    if (!index) throw new Error(errors.join(" "));
    const added = await index.addDirectory({ path: out });
    if (added.errors.length > 0) throw new Error(added.errors.join(" "));
    const written = await index.writeFiles({ outputPath: join(out, "pagefind") });
    if (written.errors.length > 0) throw new Error(written.errors.join(" "));
  } finally {
    await pagefind.close();
  }
}

function write(out: string, path: string, text: string): void {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export async function exportSite(
  siteDir: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const site = resolve(siteDir);
  const out = resolve(options.out ?? join(site, "out"));
  const removedFile = join(site, "export", "removed.json");
  const list = existsSync(removedFile)
    ? (JSON.parse(readFileSync(removedFile, "utf8")) as {
        removed: string[];
        replaced: Record<string, string>;
      })
    : { removed: [], replaced: {} };
  const removed = options.removed ?? list.removed;
  const replaced = options.replaced ?? list.replaced;
  const check = checkExport(site, { ...options, removed, replaced });
  const result: ExportResult = {
    ok: false,
    check,
    out,
    written: [],
    refusedRedirects: [],
    problems: [],
  };
  if (!check.ok) return result;

  await (options.build ?? runSiteBuild)(site, out);

  // The finished export must have a home page and a 404 page, or the host shows its own error pages.
  for (const file of ["index.html", "404.html"])
    if (!existsSync(join(out, file))) result.problems.push(`The export has no ${file}.`);

  if (options.uploads) {
    if (existsSync(options.uploads))
      // The original theme packages are kept for the site only; they are never published.
      cpSync(options.uploads, join(out, "uploads"), {
        recursive: true,
        filter: (from) => {
          const packages = join(options.uploads!, "theme-packages");
          return from !== packages && !from.startsWith(packages + sep);
        },
      });
    else result.problems.push(`The uploads folder ${options.uploads} was not found.`);
  }

  try {
    await (options.search ?? runPagefind)(out);
  } catch (error) {
    result.problems.push(
      `The search index could not be made: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const files = buildRedirectFiles(options.redirects ?? []);
  result.refusedRedirects = files.refused;
  if (files.redirectsFile) {
    write(out, "_redirects", files.redirectsFile);
    write(out, ".htaccess", files.htaccess);
    result.written.push("_redirects", ".htaccess");
    for (const page of files.pages) {
      write(out, page.path, page.html);
      result.written.push(page.path);
    }
  }
  result.ok = result.problems.length === 0;
  return result;
}
