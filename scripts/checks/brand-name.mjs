// D84 and D87: the product name lives in one place (brand.json), so the final name is a
// mechanical change. Code may import "@oks-page/..." packages and the installable package
// ("oks-page", "oks-page/next" and so on), but must not write the bare product name as a string.
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
        // An import of the package itself names it (the name is the package's), so import paths are not text.
        const text = line.replace(
          new RegExp(`(from|import\\(|require\\()\\s*["']${brand.product}(/[^"']*)?["']`, "g"),
          "",
        );
        if (bare.test(text))
          problems.push(
            `${f}:${i + 1}: writes the product name "${brand.product}"; read it from brand.json`,
          );
      });
  }
  return problems;
}
