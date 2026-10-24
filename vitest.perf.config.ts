import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

// Speed tests, one file at a time, so nothing else competes for the processor.
export default defineConfig({
  resolve: base.resolve ?? {},
  test: {
    include: ["packages/*/src/**/*.perf.test.ts", "apps/*/test/**/*.perf.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
  },
});
