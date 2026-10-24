import { expect, test } from "vitest";
import * as m from "./index.js";

test("media package loads", () => {
  expect(m.packageName).toBe("media");
});
