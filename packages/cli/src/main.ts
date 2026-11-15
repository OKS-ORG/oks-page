// The `oks` command line: `oks check [folder]`, `oks export [folder] [--check] [--out folder] [--redirects file.json]
// [--uploads folder]` and `oks media migrate --to s3|local [--uploads folder]`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { localAdapter, migrateFiles, s3Adapter, s3OptionsFromEnv } from "@oks-page/media";
import { checkPlugin, formatCheck } from "./check.js";
import { exportSite } from "./export.js";
import { checkExport, formatExportCheck } from "./export-check.js";
import type { Redirect } from "@oks-page/seo";

const USAGE = [
  "Usage: oks check [folder]   Check a plugin before you publish it.",
  "       oks export [folder] [--check] [--out folder] [--redirects file.json] [--uploads folder]",
  "                            Check a site, then write it as plain files.",
  "       oks media migrate --to s3|local [--uploads folder]",
  "                            Copy every uploaded file between the uploads folder and the S3 bucket set in OKS_S3_*.",
].join("\n");

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
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "media" && rest[0] === "migrate") return migrate(rest.slice(1), out, env);
  const values = new Set([flag(rest, "--out"), flag(rest, "--redirects"), flag(rest, "--uploads")]);
  const folder = rest.find((a) => !a.startsWith("--") && !values.has(a));
  if (command === "check") {
    const result = await checkPlugin(folder ?? ".");
    out(formatCheck(result));
    return result.ok ? 0 : 1;
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
