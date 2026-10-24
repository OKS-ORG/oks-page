// AD-47 (spec 07): the bundle must use ONE copy of React. Two copies crash with a
// "useCallback of null" error. pnpm keeps each installed version in node_modules/.pnpm.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function checkOneReact(root) {
  const store = join(root, "node_modules", ".pnpm");
  if (!existsSync(store)) return [];
  const problems = [];
  for (const pkg of ["react", "react-dom"]) {
    const copies = readdirSync(store).filter((d) => d.startsWith(`${pkg}@`));
    const versions = new Set(copies.map((d) => d.split("_")[0]));
    if (versions.size > 1) {
      problems.push(`more than one version of ${pkg} is installed: ${[...versions].join(", ")}`);
    } else if (copies.length > 1) {
      problems.push(
        `more than one copy of ${pkg} is installed (different peer sets): ${copies.join(", ")}`,
      );
    }
  }
  return problems;
}
