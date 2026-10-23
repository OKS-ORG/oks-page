import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP = new Set(["node_modules", ".git", ".next", "dist", ".turbo", "coverage"]);

// Every file under root, as paths relative to root (skips dependency and build folders).
export function listFiles(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(root, full, out);
    else out.push(relative(root, full));
  }
  return out;
}

export function read(root, file) {
  return readFileSync(join(root, file), "utf8");
}

export const isCode = (f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f);
export const isTest = (f) => /\.test\.[a-z]+$/.test(f);
