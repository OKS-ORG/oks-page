// EC-32 (spec 03): public and stored HTML is made only by our own writer.
// oks-ui's blocksToHtml must not be used in product code.
import { isCode, isTest, listFiles, read } from "./lib.mjs";

export function checkNoBlocksToHtml(root) {
  const problems = [];
  for (const f of listFiles(root)) {
    if (!isCode(f) || isTest(f) || f.startsWith("scripts/checks/")) continue;
    if (/\bblocksToHtml\b/.test(read(root, f))) {
      problems.push(`${f}: uses blocksToHtml (EC-32: use our own HTML writer)`);
    }
  }
  return problems;
}
