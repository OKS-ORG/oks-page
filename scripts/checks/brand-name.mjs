// D84 and D87: the product name lives in one place (brand.json), so the final name is a
// mechanical change. Code may import "@oks-page/..." packages, but must not write the bare
// product name as a string.
import { isCode, isTest, listFiles, read } from "./lib.mjs";

export function checkBrandName(root) {
  const brand = JSON.parse(read(root, "brand.json"));
  const bare = new RegExp(`(?<![@\\w/-])${brand.product}(?![\\w-])`);
  const problems = [];
  for (const f of listFiles(root)) {
    if (!isCode(f) || isTest(f) || f.startsWith("scripts/checks/")) continue;
    read(root, f)
      .split("\n")
      .forEach((line, i) => {
        if (bare.test(line))
          problems.push(
            `${f}:${i + 1}: writes the product name "${brand.product}"; read it from brand.json`,
          );
      });
  }
  return problems;
}
