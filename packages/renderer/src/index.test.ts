import { expect, test } from "vitest";
import * as m from "./index.js";

test("renderer package loads", () => {
  expect(m.packageName).toBe("renderer");
});
