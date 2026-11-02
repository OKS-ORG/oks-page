// The `oks` command line: `oks check [folder]` and `oks export [folder] [--check]`.
import { checkPlugin, formatCheck } from "./check.js";
import { checkExport, formatExportCheck } from "./export-check.js";

/** Runs one command and returns the exit code: 0 passed, 1 the check failed, 2 the command was not understood. */
export async function runCli(argv: string[], out: (text: string) => void): Promise<number> {
  const [command, ...rest] = argv;
  const folder = rest.find((a) => !a.startsWith("--"));
  if (command === "check") {
    const result = await checkPlugin(folder ?? ".");
    out(formatCheck(result));
    return result.ok ? 0 : 1;
  }
  if (command === "export") {
    // The checks always run first. Building the files comes in the next step of S6.
    const result = checkExport(folder ?? ".");
    out(formatExportCheck(result));
    return result.ok ? 0 : 1;
  }
  out(
    [
      "Usage: oks check [folder]   Check a plugin before you publish it.",
      "       oks export [folder] --check   Check that a site can be exported as plain files.",
    ].join("\n"),
  );
  return 2;
}
