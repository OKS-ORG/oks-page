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
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(site, "out"));
const work = join(site, ".export-build");

/**
 * The font route is left out of the export, so the font files the pages use are written as plain files in `fonts/`: every
 * address of the form /fonts/<name>.woff2 found in the exported pages that is exactly one of the library's.
 */
async function writeFontFiles(folder) {
  const core = join(site, "..", "..", "packages", "core", "dist");
  const load = (name) => import(pathToFileURL(join(core, name)).href);
  const { fontFileByName } = await load("theme.js");
  const { FONT_FILES } = await load("font-files.js");
  const wanted = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(html|css|txt)$/.test(entry.name))
        for (const m of readFileSync(path, "utf8").matchAll(
          /\/fonts\/([a-z0-9-]+\.[0-9a-f]{16}\.woff2)/g,
        ))
          wanted.add(m[1]);
    }
  };
  walk(folder);
  for (const name of wanted) {
    const found = fontFileByName(name);
    if (!found) continue;
    mkdirSync(join(folder, "fonts"), { recursive: true });
    writeFileSync(
      join(folder, "fonts", name),
      Buffer.from(FONT_FILES[found.file.sha256], "base64"),
    );
  }
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
for (const name of readdirSync(site)) {
  if (
    [".next", ".export-build", "out", "test", "scripts", "export", "node_modules"].includes(name) ||
    name.startsWith(".e2e-")
  )
    continue;
  cpSync(join(site, name), join(work, name), { recursive: true });
}
// Dependencies are shared, not copied.
symlinkSync(join(site, "node_modules"), join(work, "node_modules"), "dir");
// The files an export leaves out are listed in export/removed.json, so `oks export` checks the same set.
const removed = JSON.parse(readFileSync(join(site, "export", "removed.json"), "utf8"));
for (const path of removed.removed) rmSync(join(work, path), { recursive: true, force: true });
cpSync(join(site, "export", "page.tsx"), join(work, "app", "[[...slug]]", "page.tsx"));
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
  await writeFontFiles(out);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Exported to ${out}`);
