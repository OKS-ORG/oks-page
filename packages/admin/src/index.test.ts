import { expect, test } from "vitest";
import * as m from "./index.js";

test("admin package loads", () => {
  expect(m.packageName).toBe("admin");
});
