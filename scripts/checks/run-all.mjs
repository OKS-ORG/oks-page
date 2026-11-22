import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBrandName } from "./brand-name.mjs";
import { checkFieldQueries } from "./field-queries.mjs";
import { checkFirstPartyPlugins } from "./first-party-plugins.mjs";
import { checkNoBlocksToHtml } from "./no-blocks-to-html.mjs";
import { checkOneReact } from "./one-react.mjs";

export const checks = {
  "one copy of React (AD-47)": checkOneReact,
  "no blocksToHtml in product code (EC-32)": checkNoBlocksToHtml,
  "product name only in brand.json (D84)": checkBrandName,
  "custom field queries only through the builder (DM-19)": checkFieldQueries,
  "shipped plugin files match their source (spec 16)": checkFirstPartyPlugins,
  // The schema parity check (DM-16) is added in S2, when the two schemas exist.
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? ".");
  let failed = false;
  for (const [name, fn] of Object.entries(checks)) {
    const problems = await fn(root);
    console.log(`${problems.length ? "FAIL" : "ok  "} ${name}`);
    for (const p of problems) console.log(`     ${p}`);
    if (problems.length) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
