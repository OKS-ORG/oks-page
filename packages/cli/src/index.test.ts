import { expect, test } from "vitest";
import * as m from "./index.js";

test("cli package loads", () => {
  expect(m.packageName).toBe("cli");
});
