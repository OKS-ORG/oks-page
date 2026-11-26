// What the update checks need from the running site: the address of the list, the version of the core and the plugins
// that are installed. The address comes from OKS_UPDATE_URL; until we publish a list there is none, and nothing is fetched.
import { loadUpdateView, type InstalledItem, type UpdateView } from "@oks-page/core";
import type { SqlRunner } from "@oks-page/db";
import { listPlugins } from "./plugin-admin";

export const updateUrl = (): string | undefined =>
  process.env["OKS_UPDATE_URL"]?.trim() || undefined;

/** The address of the small urgent list (security warnings only), looked at every hour. OKS_UPDATE_URGENT_URL; none until we publish one. */
export const urgentUpdateUrl = (): string | undefined =>
  process.env["OKS_UPDATE_URGENT_URL"]?.trim() || undefined;

/** What the request says about the sender: the product name, nothing else. */
export const userAgent = (): string => process.env["OKS_PRODUCT"]?.trim() || "oks";

/** The core version in use; a site run from a source folder without one is "0.0.0", which no warning names. */
export const coreVersion = (): string => {
  const v = process.env["OKS_VERSION"] ?? "";
  return /^\d+\.\d+\.\d+/.test(v) ? v : "0.0.0";
};

export async function installedItems(runner: SqlRunner, siteId: string): Promise<InstalledItem[]> {
  return (await listPlugins(runner, siteId)).map((p) => ({
    key: p.id,
    kind: "plugin" as const,
    name: p.name,
    version: p.version,
  }));
}

export async function currentUpdateView(runner: SqlRunner, siteId: string): Promise<UpdateView> {
  return loadUpdateView(
    runner,
    siteId,
    { core: coreVersion(), items: await installedItems(runner, siteId) },
    { url: updateUrl() },
  );
}
