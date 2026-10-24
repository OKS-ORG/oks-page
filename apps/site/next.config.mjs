import { fileURLToPath } from "node:url";

// OKS_BUILD=export builds the public pages as plain files (static mode). The data module is the one file that differs.
const exportBuild = process.env.OKS_BUILD === "export";

/** @type {import('next').NextConfig} */
export default {
  // Cache components cannot be used with output: export (Next.js 16.4: "PPR cannot be enabled in export mode"), so the
  // export build turns them off; its data module does no caching anyway.
  // New projects should turn cacheComponents and partialPrefetching on together (Next.js 16.4 notice).
  ...(exportBuild ? {} : { cacheComponents: true, partialPrefetching: true }),
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
  // The admin and the API are for one person at a time: a CDN never stores them (decision D81). Not in an export.
  ...(exportBuild
    ? {}
    : {
        async headers() {
          return ["/admin/:path*", "/api/:path*"].map((source) => ({
            source,
            headers: [{ key: "Cache-Control", value: "private, no-store" }],
          }));
        },
      }),
  serverExternalPackages: ["better-sqlite3", "pg"],
  turbopack: {
    resolveAlias: { "@data": exportBuild ? "./src/data/export.ts" : "./src/data/server.ts" },
  },
};
