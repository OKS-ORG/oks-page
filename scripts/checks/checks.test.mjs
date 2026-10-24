import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { checkBrandName } from "./brand-name.mjs";
import { checkFieldQueries } from "./field-queries.mjs";
import { checkNoBlocksToHtml } from "./no-blocks-to-html.mjs";
import { checkOneReact } from "./one-react.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "oks-check-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("AD-47: two versions of React fail, one passes", () => {
  const bad = fixture({
    "node_modules/.pnpm/react@19.3.1/x": "",
    "node_modules/.pnpm/react@18.3.1/x": "",
  });
  expect(checkOneReact(bad)).toHaveLength(1);
  const good = fixture({
    "node_modules/.pnpm/react@19.3.1/x": "",
    "node_modules/.pnpm/react-dom@19.3.1_react@19.3.1/x": "",
  });
  expect(checkOneReact(good)).toEqual([]);
});

test("AD-47: one version with two peer sets fails", () => {
  const bad = fixture({
    "node_modules/.pnpm/react-dom@19.3.1_react@19.3.1/x": "",
    "node_modules/.pnpm/react-dom@19.3.1_react@19.3.0/x": "",
  });
  expect(checkOneReact(bad)).toHaveLength(1);
});

test("EC-32: blocksToHtml in product code fails; a test file may mention it", () => {
  const bad = fixture({ "packages/renderer/src/a.ts": 'import { blocksToHtml } from "oks-ui";\n' });
  expect(checkNoBlocksToHtml(bad)).toHaveLength(1);
  const ok = fixture({
    "packages/renderer/src/a.ts": "export const a = 1;\n",
    "packages/renderer/src/a.test.ts": "blocksToHtml;\n",
  });
  expect(checkNoBlocksToHtml(ok)).toEqual([]);
});

test("D84: the bare product name in code fails; the scope in an import passes", () => {
  const brand = JSON.stringify({ product: "oks-page" });
  const bad = fixture({
    "brand.json": brand,
    "packages/cli/src/a.ts": 'export const n = "oks-page";\n',
  });
  expect(checkBrandName(bad)).toHaveLength(1);
  const ok = fixture({
    "brand.json": brand,
    "packages/cli/src/a.ts": 'import { x } from "@oks-page/core";\n',
  });
  expect(checkBrandName(ok)).toEqual([]);
});

test("DM-19: a raw JSON operator outside the field builder fails; inside it, and in a test, passes", () => {
  const bad = fixture({
    "packages/core/src/list.ts": "const q = `select * from entries order by fields ->> 'price'`;\n",
  });
  expect(checkFieldQueries(bad)).toHaveLength(1);
  const bad2 = fixture({ "packages/core/src/list.ts": "sql`json_extract(fields, '$.price')`;\n" });
  expect(checkFieldQueries(bad2)).toHaveLength(1);
  const ok = fixture({
    "packages/db/src/fields/expression.ts": "const e = `(\"fields\" ->> '$.x')`;\n",
    "packages/db/src/fields/fields.test.ts": "json_extract(fields);\n",
    "packages/core/src/list.ts": "export const a = 1;\n",
  });
  expect(checkFieldQueries(ok)).toEqual([]);
});
