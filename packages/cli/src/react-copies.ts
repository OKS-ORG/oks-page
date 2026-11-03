// One copy of React (spec 07, AD-47): two copies in one page crash ("Cannot read properties of null (reading 'useCallback')").
// This finds every copy of React that a folder can reach, so a check can fail when there is more than one.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface ReactCopy {
  /** The real folder of the copy (links are followed, so two links to one copy count once). */
  path: string;
  version: string;
}

const MAX_DEPTH = 6;

const names = (folder: string): string[] => {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
};

/** Looks in `dir/node_modules`, in the `node_modules` of every package inside it, and in pnpm's store folder. */
export function findReactCopies(dir: string): ReactCopy[] {
  const found = new Map<string, ReactCopy>();
  const scan = (modules: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const name of names(modules)) {
      const path = join(modules, name);
      if (name === "react") {
        try {
          const manifest = join(path, "package.json");
          if (!existsSync(manifest)) continue;
          const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
            name?: string;
            version?: string;
          };
          if (pkg.name !== "react") continue;
          const real = realpathSync(path);
          found.set(real, { path: real, version: pkg.version ?? "unknown" });
        } catch {
          /* not a readable package: skip it */
        }
      } else if (name === ".pnpm") {
        for (const entry of names(path)) scan(join(path, entry, "node_modules"), depth + 1);
      } else if (name.startsWith("@")) {
        for (const inner of names(path)) scan(join(path, inner, "node_modules"), depth + 1);
      } else if (!name.startsWith(".")) {
        scan(join(path, "node_modules"), depth + 1);
      }
    }
  };
  scan(join(dir, "node_modules"), 1);
  return [...found.values()];
}

/** The sentence a check shows when there is more than one copy. */
export function describeReactCopies(copies: ReactCopy[]): string | null {
  if (copies.length <= 1) return null;
  const list = copies.map((c) => `${c.path} (${c.version})`).join("; ");
  return `There are ${copies.length} copies of React (${list}). Two copies in one page make it crash. Remove the extra one so that every package uses the same React.`;
}
