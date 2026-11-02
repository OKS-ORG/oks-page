import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests read the packages from their source, so no build is needed first.
  resolve: {
    alias: [
      {
        find: "@oks-page/db/testing",
        replacement: new URL("./packages/db/src/testing/harness.ts", import.meta.url).pathname,
      },
      {
        find: "@oks-page/db/memory",
        replacement: new URL("./packages/db/src/memory.ts", import.meta.url).pathname,
      },
      {
        find: "@oks-page/seo",
        replacement: new URL("./packages/seo/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@oks-page/db",
        replacement: new URL("./packages/db/src/index.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Speed tests run alone, in their own step (vitest.perf.config.ts).
    exclude: ["**/node_modules/**", "**/*.perf.test.ts"],
  },
});
