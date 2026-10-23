import { expect, test } from "vitest";
import * as m from "./index.js";

test("editor package loads", () => {
  expect(m.packageName).toBe("editor");
});
