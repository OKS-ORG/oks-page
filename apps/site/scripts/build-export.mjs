// Builds the public pages as plain files (static mode), reading the database once.
//   node scripts/build-export.mjs <output folder>
// Next.js cannot export an app that has a proxy, API routes or Server Actions, and the page needs the list of pages to write. So the
// build is made in a temporary copy of the app without those, with the export page in place of the server page.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(site, "out"));
const work = join(site, ".export-build");

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
for (const name of readdirSync(site)) {
  if (
    [
      ".next",
      ".export-build",
      "out",
      "test",
      "scripts",
      "export",
      "cache-handlers",
      "node_modules",
    ].includes(name)
  )
    continue;
  cpSync(join(site, name), join(work, name), { recursive: true });
}
// Dependencies are shared, not copied.
symlinkSync(join(site, "node_modules"), join(work, "node_modules"), "dir");
for (const path of [
  "src/proxy.ts",
  "src/app/api",
  "src/app/not-found-handler",
  "src/app/test-form",
])
  rmSync(join(work, path), { recursive: true, force: true });
cpSync(join(site, "export", "page.tsx"), join(work, "src", "app", "[[...slug]]", "page.tsx"));
// In the copy, "@data" means the export data module (for the type check as well as the build).
const tsconfig = JSON.parse(readFileSync(join(work, "tsconfig.json"), "utf8"));
tsconfig.compilerOptions.paths = { "@data": ["./src/data/export.ts"] };
tsconfig.exclude = ["node_modules"];
writeFileSync(join(work, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

try {
  execFileSync(
    process.execPath,
    [join(site, "node_modules", "next", "dist", "bin", "next"), "build"],
    {
      cwd: work,
      env: { ...process.env, OKS_BUILD: "export" },
      stdio: "inherit",
    },
  );
  if (!existsSync(join(work, "out"))) throw new Error("The export build made no output folder");
  rmSync(out, { recursive: true, force: true });
  cpSync(join(work, "out"), out, { recursive: true });
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Exported to ${out}`);
