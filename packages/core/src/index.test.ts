import { expect, test } from "vitest";
import * as m from "./index.js";

test("core package loads", () => {
  expect(m.packageName).toBe("core");
});
