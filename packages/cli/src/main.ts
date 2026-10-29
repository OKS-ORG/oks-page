// The `oks` command line. For now: `oks check [folder]`.
import { checkPlugin, formatCheck } from "./check.js";

/** Runs one command and returns the exit code: 0 passed, 1 the check failed, 2 the command was not understood. */
export async function runCli(argv: string[], out: (text: string) => void): Promise<number> {
  const [command, folder] = argv;
  if (command === "check") {
    const result = await checkPlugin(folder ?? ".");
    out(formatCheck(result));
    return result.ok ? 0 : 1;
  }
  out("Usage: oks check [folder]   Check a plugin before you publish it.");
  return 2;
}
