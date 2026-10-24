// OKS_BUILD=export builds the public pages as plain files (static mode). The data module is the one file that differs.
const exportBuild = process.env.OKS_BUILD === "export";

/** @type {import('next').NextConfig} */
export default {
  cacheComponents: true,
  poweredByHeader: false,
  ...(exportBuild ? { output: "export" } : {}),
  serverExternalPackages: ["better-sqlite3", "pg"],
  turbopack: {
    resolveAlias: { "@data": exportBuild ? "./src/data/export.ts" : "./src/data/server.ts" },
  },
};
