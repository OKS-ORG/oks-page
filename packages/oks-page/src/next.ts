// `withOksPage(config)`: the Next.js settings a project of this package needs, added to the project's own config.
// Loaded by Node when Next.js reads next.config.mjs, so this file imports nothing of its own.
import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The package's own name, read from its package.json, so the product name is written in one place (D84).
const { name, version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

const unique = <T>(list: T[]): T[] => [...new Set(list)];

export function withOksPage(config: NextConfig = {}): NextConfig {
  // OKS_BUILD=export builds the public pages as plain files (static mode). The data module is the one file that differs.
  const exportBuild = process.env["OKS_BUILD"] === "export";
  const own = config as Record<string, unknown>;
  const turbopack = (config.turbopack ?? {}) as { resolveAlias?: Record<string, unknown> };
  const headers = config.headers;
  return {
    // Cache components cannot be used with output: export (Next.js 16.4: "PPR cannot be enabled in export mode"), so
    // the export build turns them off; its data module does no caching anyway.
    // New projects should turn cacheComponents and partialPrefetching on together (Next.js 16.4 notice).
    ...(exportBuild ? {} : { cacheComponents: true, partialPrefetching: true }),
    poweredByHeader: false,
    // A static host has no image optimizer: images are plain files made at upload (spec 09, ST-07).
    ...(exportBuild ? { output: "export" as const, images: { unoptimized: true } } : {}),
    // Pages are kept in each process; "which tags changed" is shared through the database (decision D82).
    ...(exportBuild
      ? {}
      : {
          cacheHandlers: {
            default: fileURLToPath(new URL("../cache-handlers/shared-tags.cjs", import.meta.url)),
          },
        }),
    ...config,
    // The admin footer shows these.
    env: { ...config.env, OKS_PRODUCT: name, OKS_VERSION: version },
    // The admin and the API are for one person at a time: a CDN never stores them (decision D81). Not in an export.
    ...(exportBuild
      ? {}
      : {
          async headers() {
            const mine = ["/admin/:path*", "/api/:path*"].map((source) => ({
              source,
              headers: [{ key: "Cache-Control", value: "private, no-store" }],
            }));
            return [...mine, ...(headers ? await headers() : [])];
          },
        }),
    // The database drivers are native or Node-only, so they are not bundled. The package is compiled code in
    // node_modules: Next.js must transpile it, or the build fails with "Cannot read properties of null (reading 'useContext')".
    serverExternalPackages: unique([
      ...((own["serverExternalPackages"] as string[] | undefined) ?? []),
      "better-sqlite3",
      "pg",
      "sharp",
      "jsdom",
    ]),
    transpilePackages: unique([...(config.transpilePackages ?? []), name]),
    turbopack: {
      ...turbopack,
      resolveAlias: {
        ...turbopack.resolveAlias,
        "@data": exportBuild ? `${name}/data/export` : `${name}/data/server`,
      },
    },
  };
}
