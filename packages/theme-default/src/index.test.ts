import { expect, test } from "vitest";
import * as m from "./index.js";

test("theme-default package loads", () => {
  expect(m.packageName).toBe("theme-default");
});
