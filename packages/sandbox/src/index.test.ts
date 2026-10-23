import { expect, test } from "vitest";
import * as m from "./index.js";

test("sandbox package loads", () => {
  expect(m.packageName).toBe("sandbox");
});
