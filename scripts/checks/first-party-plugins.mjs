// The plugin file kept for each plugin that ships with the product must be the one its source makes now. Otherwise a
// change to the plugin (apps/forms-plugin) would not reach new sites, or the kept file would be one nobody can rebuild.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIRST_PARTY, canBuild, expectedFile } from "../first-party-plugins-lib.mjs";

export async function checkFirstPartyPlugins(root) {
  // Needs the built packages (`tsc -b`); in a folder that has none (a copy used by a test) there is nothing to compare.
  if (!canBuild(root)) return [];
  const problems = [];
  for (const { dir, out } of FIRST_PARTY) {
    if (!existsSync(join(root, dir))) continue;
    const kept = existsSync(join(root, out)) ? readFileSync(join(root, out), "utf8") : null;
    if (kept !== (await expectedFile(root, dir)))
      problems.push(
        `${out} is not what ${dir} makes now; run: node scripts/first-party-plugins.mjs`,
      );
  }
  return problems;
}
