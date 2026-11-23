// The manifest of a plugin file, read from the plugin's package.json (`oksPage` and the usual fields). `oks pack` writes it
// into the plugin file; the scripts that make the plugins shipped with the product use the same function, so a shipped
// plugin is exactly what `oks pack` would make.
import type { PluginFileManifest } from "@oks-page/sandbox";

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** The author of a package.json: a text, or an object with a name. */
const authorOf = (pkg: Record<string, unknown>): string => {
  const a = pkg["author"];
  if (typeof a === "string") return a.replace(/\s*[<(].*$/, "").slice(0, 80);
  if (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string")
    return (a as { name: string }).name.slice(0, 80);
  return "";
};

export function pluginManifestOf(pkg: Record<string, unknown>): PluginFileManifest {
  const raw = pkg["oksPage"] as Record<string, unknown>;
  return {
    id: raw["id"] as string,
    version: pkg["version"] as string,
    displayName: text(raw["displayName"], 80) || (raw["id"] as string),
    description: text(raw["description"], 300) || text(pkg["description"], 300),
    author: text(raw["author"], 80) || authorOf(pkg),
    permissions: raw["permissions"] as string[],
    hooks: raw["hooks"] as string[],
    blocks: raw["blocks"] as string[],
    ...(raw["blockInfo"] && typeof raw["blockInfo"] === "object"
      ? { blockInfo: raw["blockInfo"] as NonNullable<PluginFileManifest["blockInfo"]> }
      : {}),
    ...(raw["routes"] && typeof raw["routes"] === "object"
      ? { routes: raw["routes"] as NonNullable<PluginFileManifest["routes"]> }
      : {}),
    ...(raw["jobs"] && typeof raw["jobs"] === "object" && !Array.isArray(raw["jobs"])
      ? { jobs: raw["jobs"] as NonNullable<PluginFileManifest["jobs"]> }
      : {}),
    ...(Array.isArray(raw["personalData"])
      ? { personalData: raw["personalData"] as NonNullable<PluginFileManifest["personalData"]> }
      : {}),
    ...(Array.isArray(raw["adminPages"])
      ? { adminPages: raw["adminPages"] as NonNullable<PluginFileManifest["adminPages"]> }
      : {}),
    ...(typeof raw["priority"] === "number" ? { priority: raw["priority"] } : {}),
    ...(raw["settings"] && typeof raw["settings"] === "object"
      ? { settings: raw["settings"] as NonNullable<PluginFileManifest["settings"]> }
      : {}),
  };
}
