// DM-19 (spec 01, section 4, rule 1): every sort or filter on a custom field is written by one function.
// A query that writes the JSON expression itself (another operator, another cast) makes the database ignore
// the index and scan every entry. So the JSON operators may only appear inside packages/db/src/fields/.
import { isCode, isTest, listFiles, read } from "./lib.mjs";

const ALLOWED = "packages/db/src/fields/";
const RAW_JSON_ACCESS =
  /->>|#>>|json_extract\s*\(|jsonb_extract_path|jsonb_path_query|json_each\s*\(/i;

export function checkFieldQueries(root) {
  const problems = [];
  for (const f of listFiles(root)) {
    const path = f.replaceAll("\\", "/");
    if (
      !isCode(path) ||
      isTest(path) ||
      path.startsWith(ALLOWED) ||
      path.startsWith("scripts/checks/")
    )
      continue;
    read(root, f)
      .split("\n")
      .forEach((line, i) => {
        if (RAW_JSON_ACCESS.test(line))
          problems.push(
            `${path}:${i + 1}: reads a JSON field directly; use buildEntryList or fieldExpression (DM-19)`,
          );
      });
  }
  return problems;
}
