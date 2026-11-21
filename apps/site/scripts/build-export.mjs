// Builds the public pages as plain files (static mode), reading the database once.
//   node scripts/build-export.mjs <output folder>
// The work is done by the package (its export-build module), the same for every project.
import { runExportBuild } from "oks-page/export-build";

await runExportBuild(process.argv[2]);
