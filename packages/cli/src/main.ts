// The `oks` command line: `oks check [folder]` and `oks export [folder] [--check] [--out folder] [--redirects file.json] [--uploads folder]`.
import { readFileSync } from "node:fs";
import { checkPlugin, formatCheck } from "./check.js";
import { exportSite } from "./export.js";
import { checkExport, formatExportCheck } from "./export-check.js";
import type { Redirect } from "@oks-page/seo";

const USAGE = [
  "Usage: oks check [folder]   Check a plugin before you publish it.",
  "       oks export [folder] [--check] [--out folder] [--redirects file.json] [--uploads folder]",
  "                            Check a site, then write it as plain files.",
].join("\n");

/** The text after a flag such as --out, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Runs one command and returns the exit code: 0 passed, 1 the check failed, 2 the command was not understood. */
export async function runCli(argv: string[], out: (text: string) => void): Promise<number> {
  const [command, ...rest] = argv;
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
