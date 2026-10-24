import { expect, test } from "vitest";
import * as m from "./index.js";

test("db package loads", () => {
  expect(m.packageName).toBe("db");
});
