import { expect, test } from "vitest";
import * as m from "./index.js";

test("sdk package loads", () => {
  expect(m.packageName).toBe("sdk");
});
