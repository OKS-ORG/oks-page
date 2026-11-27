// Writes the font library's two data files from the unpacked Fontsource packages.
//
//   node scripts/build-font-library.mjs <folder with one sub-folder per package> <folder with the .tgz files>
//
// Each sub-folder holds `LICENSE` and `files/<name>-<script>-<weight>-normal.woff2` (as unpacked from the package).
// The tarball's fingerprint is read from `<tgz folder>/<name>.integrity` (the registry's `dist.integrity`, written when
// the package was downloaded and compared). The output is committed; this script is run again only to add a font or to
// move to a newer pinned version (ADR 0028). It writes:
//   packages/core/src/font-library-list.ts   the list: names, versions, licence, copyright and each file's fingerprint
//   packages/core/src/font-files.ts          the files themselves (base64), loaded only by the font route
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , source, tarballs] = process.argv;
if (!source || !tarballs) {
  console.error("usage: node scripts/build-font-library.mjs <unpacked folder> <tgz folder>");
  process.exit(1);
}

/** key, display name, kind: the order here is the order of the list. */
const FONTS = [
  ["inter", "Inter", "sans"],
  ["roboto", "Roboto", "sans"],
  ["open-sans", "Open Sans", "sans"],
  ["montserrat", "Montserrat", "sans"],
  ["poppins", "Poppins", "sans"],
  ["dm-sans", "DM Sans", "sans"],
  ["figtree", "Figtree", "sans"],
  ["manrope", "Manrope", "sans"],
  ["hind", "Hind", "sans"],
  ["noto-sans-devanagari", "Noto Sans Devanagari", "sans"],
  ["source-serif-4", "Source Serif 4", "serif"],
  ["eb-garamond", "EB Garamond", "serif"],
  ["noto-serif-devanagari", "Noto Serif Devanagari", "serif"],
  ["jetbrains-mono", "JetBrains Mono", "mono"],
];
const WEIGHTS = [400, 700];
// The parts of the alphabet kept: Latin for every font, and Devanagari for the ones that carry Hindi (the Fontsource packages hold more).
const SCRIPTS = {
  poppins: ["latin", "devanagari"],
  hind: ["latin", "devanagari"],
  "noto-sans-devanagari": ["latin", "devanagari"],
  "noto-serif-devanagari": ["latin", "devanagari"],
};
// The licence file of the Source Serif 4 package names only "Google Inc." as the holder.
const COPYRIGHT_FIXED = { "source-serif-4": "Google Inc." };

function copyrightOf(key, licence) {
  if (COPYRIGHT_FIXED[key]) return COPYRIGHT_FIXED[key];
  let paragraph = licence.split("\n\n")[0].replace(/\n/g, " ");
  const stop = /\s+[\w\-[\],]+\.(ttf|otf):/.exec(paragraph);
  if (stop) paragraph = paragraph.slice(0, stop.index);
  return paragraph.replace(/\s+/g, " ").trim();
}

const list = [];
const files = {};
for (const [key, name, kind] of FONTS) {
  const dir = join(source, key);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licence = readFileSync(join(dir, "LICENSE"), "utf8");
  if (!/SIL OPEN FONT LICENSE Version 1\.1/i.test(licence) || pkg.license !== "OFL-1.1")
    throw new Error(`${key}: not the SIL Open Font Licence 1.1`);
  if (/\bwith Reserved Font Name\b/i.test(licence.split("PREAMBLE")[0]))
    throw new Error(`${key}: has a Reserved Font Name`);
  const integrity = readFileSync(join(tarballs, `${key}.integrity`), "utf8").trim();
  const entries = [];
  const scripts = new Set();
  for (const file of readdirSync(join(dir, "files")).sort()) {
    const m = new RegExp(`^${key}-([a-z]+)-(\\d+)-normal\\.woff2$`).exec(file);
    if (!m || !WEIGHTS.includes(Number(m[2])) || !(SCRIPTS[key] ?? ["latin"]).includes(m[1]))
      continue;
    const bytes = readFileSync(join(dir, "files", file));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    entries.push({ script: m[1], weight: Number(m[2]), sha256, bytes: bytes.length });
    files[sha256] = bytes.toString("base64");
    scripts.add(m[1]);
  }
  entries.sort((a, b) => a.script.localeCompare(b.script) || a.weight - b.weight);
  list.push({
    key,
    name,
    kind,
    scripts: [...scripts].sort((a, b) =>
      a === "latin" ? -1 : b === "latin" ? 1 : a.localeCompare(b),
    ),
    package: `@fontsource/${key}`,
    version: pkg.version,
    integrity,
    license: "OFL-1.1",
    copyright: copyrightOf(key, licence),
    files: entries,
  });
}

writeFileSync(
  "packages/core/src/font-library-list.ts",
  `// The fonts of the built-in library (ADR 0028). Written by scripts/build-font-library.mjs; do not edit by hand.
// Every font is under the SIL Open Font Licence 1.1, taken from a pinned Fontsource package whose fingerprint
// (\`integrity\`) was compared with the registry's when it was downloaded. Each file is named by its own SHA-256.
import type { LibraryFont } from "./font-library.js";

export const FONT_LIBRARY_LIST: readonly LibraryFont[] = ${JSON.stringify(list, null, 2)};
`,
);
writeFileSync(
  "packages/core/src/font-files.ts",
  `// The font files of the library as text (base64), by their SHA-256. Written by scripts/build-font-library.mjs; do not
// edit by hand. Only the font route loads this file, so the other pages never carry it.
export const FONT_FILES: Readonly<Record<string, string>> = ${JSON.stringify(files, null, 1)};
`,
);
console.log(`${list.length} fonts, ${Object.keys(files).length} files`);
