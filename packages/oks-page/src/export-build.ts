// Builds the public pages of a project as plain files (static mode), reading the database once. `oks export` runs it in the
// project's folder (through the project's own `scripts/build-export.mjs`, which only calls this).
// Next.js cannot export an app that has a proxy, API routes or Server Actions, and the page needs the list of pages to write. So the
// build is made in a temporary copy of the project without those, with the export page in place of the server page. The files left
// out and the page put in place are listed in the project's `export/removed.json`, so `oks export --check` checks the same set.
import { execFileSync } from "node:child_process";
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
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/** What a project keeps that the export build does not copy: its own build output, tests, uploads and data. */
const NOT_COPIED = [
  ".next",
  ".export-build",
  ".oks",
  "out",
  "publish",
  "test",
  "scripts",
  "export",
  "node_modules",
  "uploads",
  "data",
];

/**
 * The font route is left out of the export, so the font files the pages use are written as plain files in `fonts/`: every
 * address of the form /fonts/<name>.woff2 found in the exported pages that is exactly one of the library's, and the fonts
 * the owner uploaded (`own-<kind>-<weight>-<16 letters>.woff2`), which are read from the database the export reads.
 */
async function writeFontFiles(folder: string): Promise<void> {
  const { fontFileByName } = await import("@oks-page/core/theme");
  const { FONT_FILES } = await import("@oks-page/core/font-files");
  const wanted = new Set<string>();
  const wantedOwn = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(html|css|txt)$/.test(entry.name)) {
        const text = readFileSync(path, "utf8");
        for (const m of text.matchAll(/\/fonts\/([a-z0-9-]+\.[0-9a-f]{16}\.woff2)/g))
          wanted.add(m[1]!);
        for (const m of text.matchAll(
          /\/fonts\/(own-(?:sans|serif|mono)-(?:400|700|vf)-[0-9a-f]{16}\.woff2)/g,
        ))
          wantedOwn.add(m[1]!);
      }
    }
  };
  walk(folder);
  for (const name of wanted) {
    const found = fontFileByName(name);
    if (!found) continue;
    mkdirSync(join(folder, "fonts"), { recursive: true });
    writeFileSync(
      join(folder, "fonts", name),
      Buffer.from((FONT_FILES as Record<string, string>)[found.file.sha256]!, "base64"),
    );
  }
  await writeOwnerFontFiles(folder, wantedOwn);
}

/** The owner's own fonts used by the pages, written as plain files from the database the export reads. */
async function writeOwnerFontFiles(folder: string, names: Set<string>): Promise<void> {
  if (names.size === 0) return;
  const { loadOwnerFontFile } = await import("@oks-page/core");
  const { getRunner } = await import("./db.js");
  const runner = getRunner();
  for (const name of names) {
    const bytes = await loadOwnerFontFile(runner, name.slice(-22, -6));
    if (!bytes) continue;
    mkdirSync(join(folder, "fonts"), { recursive: true });
    writeFileSync(join(folder, "fonts", name), bytes);
  }
  // The connection is closed so the process ends.
  const native = (
    globalThis as {
      __oks?: {
        native?: { kind: string; pool?: { end(): Promise<void> }; db?: { close(): void } };
      };
    }
  ).__oks?.native;
  if (native?.kind === "postgres") await native.pool?.end();
  else native?.db?.close();
}

/** The `KEY=value` lines of an env file (a quoted value loses its quotes; comments and other lines are ignored). */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Makes the exported site of the project in `siteDir` (default: the folder the command runs in) in `outDir`. */
export async function runExportBuild(
  outDir?: string,
  siteDir: string = process.cwd(),
): Promise<void> {
  const site = resolve(siteDir);
  // The project's own settings (.env) are read here too, because the build runs in a copy of the folder: a database file named
  // with a relative path is the one in the project, not one in the copy.
  for (const [key, value] of Object.entries(readEnvFile(join(site, ".env"))))
    if (process.env[key] === undefined) process.env[key] = value;
  const sqlite = process.env["OKS_SQLITE_PATH"];
  if (sqlite) process.env["OKS_SQLITE_PATH"] = resolve(site, sqlite);
  const out = resolve(outDir ?? join(site, "out"));
  const work = join(site, ".export-build");
  const listFile = join(site, "export", "removed.json");
  const pageFile = join(site, "export", "page.tsx");
  if (!existsSync(listFile) || !existsSync(pageFile))
    throw new Error(
      `${join(site, "export")} was not found: this folder is not a project made for static export.`,
    );

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const name of readdirSync(site)) {
    if (NOT_COPIED.includes(name) || name.startsWith(".e2e-")) continue;
    cpSync(join(site, name), join(work, name), { recursive: true });
  }
  // Dependencies are shared, not copied (a project that sits inside another one finds them in the folder above).
  if (existsSync(join(site, "node_modules")))
    symlinkSync(join(site, "node_modules"), join(work, "node_modules"), "dir");
  const next = join(
    dirname(createRequire(join(site, "package.json")).resolve("next/package.json")),
    "dist",
    "bin",
    "next",
  );
  const removed = JSON.parse(readFileSync(listFile, "utf8")) as { removed: string[] };
  for (const path of removed.removed) rmSync(join(work, path), { recursive: true, force: true });
  cpSync(pageFile, join(work, "app", "[[...slug]]", "page.tsx"));
  try {
    execFileSync(process.execPath, [next, "build"], {
      cwd: work,
      env: { ...process.env, OKS_BUILD: "export" },
      stdio: "inherit",
    });
    if (!existsSync(join(work, "out"))) throw new Error("The export build made no output folder");
    rmSync(out, { recursive: true, force: true });
    cpSync(join(work, "out"), out, { recursive: true });
    await writeFontFiles(out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Exported to ${out}`);
}
