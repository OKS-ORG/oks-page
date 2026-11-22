// Writes the plugin files of the plugins that ship with the product (see first-party-plugins-lib.mjs):
//
//   node scripts/first-party-plugins.mjs
//
// Run it after `tsc -b` whenever the source of a shipped plugin (apps/forms-plugin) changes. The repository check
// fails until the kept file matches the source, so a change to the plugin cannot reach a site without its file.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_PARTY, canBuild, expectedFile } from "./first-party-plugins-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!canBuild(root)) {
  console.error("Build the packages first: pnpm build (tsc -b).");
  process.exit(1);
}
for (const { dir, out } of FIRST_PARTY) {
  writeFileSync(join(root, out), await expectedFile(root, dir));
  console.log(`Wrote ${out}`);
}
