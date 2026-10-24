import { fileURLToPath } from "node:url";

// OKS_BUILD=export builds the public pages as plain files (static mode). The data module is the one file that differs.
const exportBuild = process.env.OKS_BUILD === "export";

/** @type {import('next').NextConfig} */
export default {
  cacheComponents: true,
  // New projects should turn both on (Next.js 16.4 notice). The decision and its test are in the M1 results.
  partialPrefetching: true,
  poweredByHeader: false,
  ...(exportBuild ? { output: "export" } : {}),
  // Pages are kept in each process; "which tags changed" is shared through the database (decision D82).
  ...(exportBuild
    ? {}
    : {
        cacheHandlers: {
          default: fileURLToPath(new URL("./cache-handlers/shared-tags.cjs", import.meta.url)),
        },
      }),
  serverExternalPackages: ["better-sqlite3", "pg"],
  turbopack: {
    resolveAlias: { "@data": exportBuild ? "./src/data/export.ts" : "./src/data/server.ts" },
  },
};
