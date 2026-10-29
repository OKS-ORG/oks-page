import { expect, test } from "vitest";
import { pgSchema, sqliteSchema, tableNames } from "./index.js";

test("db package exports both schemas and the same table list", () => {
  expect(pgSchema.tableNames).toEqual(sqliteSchema.tableNames);
  expect(tableNames).toHaveLength(40);
});
