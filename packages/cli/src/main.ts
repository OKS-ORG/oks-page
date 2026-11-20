// The `oks` command line: `oks check [folder]`, `oks export [folder] [--check] [--out folder] [--redirects file.json]
// [--uploads folder]`, `oks media migrate --to s3|local [--uploads folder]`, `oks migrate` and `oks user reset <email>`.
import { build } from "esbuild";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { localAdapter, migrateFiles, s3Adapter, s3OptionsFromEnv } from "@oks-page/media";
import { checkPlugin, formatCheck } from "./check.js";
import { packPlugin } from "./pack.js";
import { folderTarget, publishSite, zipTarget } from "@oks-page/core";
import { exportSite } from "./export.js";
import { checkExport, formatExportCheck } from "./export-check.js";
import type { Redirect } from "@oks-page/seo";

const USAGE = [
  "Usage: oks check [folder]   Check a plugin before you publish it.",
  "       oks pack [folder] [--out file]   Check a plugin, then write it as one .oksplugin file to upload in Tools > Plugins.",
  "       oks publish [folder] --zip file | --folder dir\n                            Send an exported site (default folder: out) to a zip file or a folder, sending only what changed.",
  "       oks export [folder] [--check] [--out folder] [--redirects file.json] [--uploads folder]",
  "                            Check a site, then write it as plain files.",
  "       oks media migrate --to s3|local [--uploads folder]",
  "                            Copy every uploaded file between the uploads folder and the S3 bucket set in OKS_S3_*.",
  "       oks migrate          Make or update the database tables (run it in the project's folder).",
  "       oks user reset <email>",
  "                            Give an account a new one-time password and sign it out everywhere (needs the secret key in .env).",
].join("\n");

// The product's name comes from this package's own name (@<product>/cli), as the installer does.
const own = createRequire(import.meta.url)("../package.json") as { name: string };
const PRODUCT = own.name.replace(/^@/, "").replace(/\/cli$/, "");

/** The commands that work on the project's own database, found in the project's own copy of the product. */
export interface ProjectCommands {
  migrateCommand(out: (text: string) => void): Promise<number>;
  userResetCommand(
    args: string[],
    out: (text: string) => void,
    env: Record<string, string | undefined>,
  ): Promise<number>;
}

/** Reads `KEY=value` lines (a quoted value loses its quotes). Lines that are comments or not settings are ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    values[m[1]!] = value;
  }
  return values;
}

/** The project's `.env` and `.env.local` settings fill in what the environment does not already have. */
export function loadProjectEnv(folder: string, env: Record<string, string | undefined>): void {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(folder, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnvFile(readFileSync(file, "utf8"))))
      if (env[key] === undefined || env[key] === "") env[key] = value;
  }
}

/**
 * Finds the product from the project's folder (not from where this command is installed). Its files are written for the
 * site's bundler (no `.js` ending on imports), so they are bundled into one file first. The file is placed next to them,
 * so its packages (the database, the sign-in library) are found where the product itself finds them, and it is removed
 * again as soon as it has been loaded.
 */
async function loadProject(folder: string): Promise<ProjectCommands> {
  const resolve = createRequire(path.join(path.resolve(folder), "package.json")).resolve;
  const entry = resolve(`${PRODUCT}/cli-commands`);
  const outfile = path.join(path.dirname(entry), `.oks-cli-${process.pid}.mjs`);
  try {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    return (await import(pathToFileURL(outfile).href)) as ProjectCommands;
  } finally {
    rmSync(outfile, { force: true });
  }
}

/** The text after a flag such as --out, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Runs one command and returns the exit code: 0 passed, 1 the check failed, 2 the command was not understood. */
export async function runCli(
  argv: string[],
  out: (text: string) => void,
  env: Record<string, string | undefined> = process.env,
  project: (folder: string) => Promise<ProjectCommands> = loadProject,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "migrate" || (command === "user" && rest[0] === "reset")) {
    const folder = process.cwd();
    loadProjectEnv(folder, env);
    let commands: ProjectCommands;
    try {
      commands = await project(folder);
    } catch {
      out(`Problem: ${PRODUCT} is not installed here. Run this command in the project's folder.`);
      return 1;
    }
    return command === "migrate"
      ? commands.migrateCommand(out)
      : commands.userResetCommand(rest.slice(1), out, env);
  }
  if (command === "media" && rest[0] === "migrate") return migrate(rest.slice(1), out, env);
  const values = new Set([
    flag(rest, "--out"),
    flag(rest, "--redirects"),
    flag(rest, "--uploads"),
    flag(rest, "--zip"),
    flag(rest, "--folder"),
  ]);
  const folder = rest.find((a) => !a.startsWith("--") && !values.has(a));
  if (command === "check") {
    const result = await checkPlugin(folder ?? ".");
    out(formatCheck(result));
    return result.ok ? 0 : 1;
  }
  if (command === "pack") {
    const result = await packPlugin(folder ?? ".", flag(rest, "--out"));
    out(result.report);
    return result.ok ? 0 : 1;
  }
  if (command === "publish") {
    const zip = flag(rest, "--zip");
    const to = flag(rest, "--folder");
    if ((zip === undefined) === (to === undefined)) {
      out("Problem: say where to publish to: --zip <file> or --folder <dir>.");
      return 2;
    }
    const site = path.resolve(folder ?? "out");
    if (!existsSync(site)) {
      out(`Problem: ${site} was not found. Run "oks export" first.`);
      return 1;
    }
    const report = await publishSite(site, zip !== undefined ? zipTarget(zip) : folderTarget(to!));
    if (!report.ok) {
      out(
        `Problem: ${report.problem} (${report.done.length} of ${report.planned} steps were done; the place still works as it was.)`,
      );
      return 1;
    }
    const puts = report.done.filter((o) => o.kind === "put").length;
    const deletes = report.done.length - puts;
    out(
      report.planned === 0
        ? "Nothing changed: the place already has this site."
        : `Published: ${puts} file${puts === 1 ? "" : "s"} sent, ${deletes} removed.`,
    );
    return 0;
  }
  if (command === "export") {
    if (rest.includes("--check")) {
      const result = checkExport(folder ?? ".");
      out(formatExportCheck(result));
      return result.ok ? 0 : 1;
    }
    const redirectsFile = flag(rest, "--redirects");
    const redirects = redirectsFile
      ? (JSON.parse(readFileSync(redirectsFile, "utf8")) as Redirect[])
      : [];
    const outDir = flag(rest, "--out");
    const uploads = flag(rest, "--uploads");
    const result = await exportSite(folder ?? ".", {
      ...(outDir ? { out: outDir } : {}),
      ...(uploads ? { uploads } : {}),
      redirects,
    });
    out(formatExportCheck(result.check));
    if (!result.check.ok) return 1;
    for (const r of result.refusedRedirects)
      out(`Redirect left out (${r.redirect.from}): ${r.reason}`);
    for (const p of result.problems) out(`Problem: ${p}`);
    out(
      result.ok
        ? `Exported to ${result.out}`
        : "The export was built but has problems (see above).",
    );
    return result.ok ? 0 : 1;
  }
  out(USAGE);
  return 2;
}

/** `oks media migrate --to s3|local`: copies, reads back and compares every file; deletes nothing. */
async function migrate(
  args: string[],
  out: (text: string) => void,
  env: Record<string, string | undefined>,
): Promise<number> {
  const to = flag(args, "--to");
  if (to !== "s3" && to !== "local") {
    out(USAGE);
    return 2;
  }
  let s3;
  try {
    // The bucket is set as for the site (OKS_S3_*); OKS_STORAGE itself does not matter here.
    s3 = s3OptionsFromEnv({ ...env, OKS_STORAGE: "s3" });
  } catch (error) {
    out(`Problem: ${(error as Error).message}`);
    return 1;
  }
  const folder = path.resolve(flag(args, "--uploads") ?? env["OKS_UPLOADS_DIR"] ?? "uploads");
  const local = localAdapter({ root: folder });
  const bucket = s3Adapter(s3!);
  const where = `the bucket ${s3!.bucket}${s3!.prefix ? ` (folder ${s3!.prefix})` : ""}`;
  out(to === "s3" ? `Copying ${folder} to ${where}…` : `Copying ${where} to ${folder}…`);
  const result = await migrateFiles(
    to === "s3" ? local : bucket,
    to === "s3" ? bucket : local,
    (done) => {
      if (done % 100 === 0) out(`${done} files…`);
    },
  );
  for (const f of result.failed) out(`Not copied: ${f.key}: ${f.reason}`);
  out(
    `${result.copied} copied and checked, ${result.alreadyThere} already there, ${result.failed.length} not copied.` +
      (result.failed.length === 0
        ? ` Nothing was deleted. ${to === "s3" ? "Set OKS_STORAGE=s3 and restart the site to use the bucket." : "Remove OKS_STORAGE=s3 and restart the site to use the folder."}`
        : " Run the command again once the problem is fixed."),
  );
  return result.failed.length === 0 ? 0 : 1;
}
