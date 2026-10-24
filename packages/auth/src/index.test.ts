import { expect, test } from "vitest";
import * as m from "./index.js";

test("auth package loads", () => {
  expect(m.packageName).toBe("auth");
});
