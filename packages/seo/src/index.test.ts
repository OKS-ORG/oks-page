import { expect, test } from "vitest";
import * as m from "./index.js";

test("seo package loads", () => {
  expect(m.packageName).toBe("seo");
});
