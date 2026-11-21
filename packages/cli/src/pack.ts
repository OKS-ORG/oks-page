// `oks pack [folder] [--out file]`: checks a plugin like `oks check` does, then writes the one file an owner uploads in
// Tools > Plugins: the manifest, the production bundle and the bundle's hash (spec 04, sections 3 and 10).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makePluginFile, readPluginFile, type PluginFileManifest } from "@oks-page/sandbox";
import { checkPlugin, formatCheck } from "./check.js";

export interface PackResult {
  ok: boolean;
  /** What the command prints. */
  report: string;
  /** Where the file was written, when it was. */
  file?: string;
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** The author of a package.json: a text, or an object with a name. */
const authorOf = (pkg: Record<string, unknown>): string => {
  const a = pkg["author"];
  if (typeof a === "string") return a.replace(/\s*[<(].*$/, "").slice(0, 80);
  if (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string")
    return (a as { name: string }).name.slice(0, 80);
  return "";
};

export async function packPlugin(dir: string, outFile?: string): Promise<PackResult> {
  const root = path.resolve(dir);
  const checked = await checkPlugin(root);
  if (!checked.ok) return { ok: false, report: formatCheck(checked) };
  if (checked.code === undefined)
    return {
      ok: false,
      report: `${formatCheck(checked)}\nFAIL  A build-time plugin has no plugin file: it is added to the project and built with it.`,
    };
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const raw = pkg["oksPage"] as Record<string, unknown>;
  const manifest: PluginFileManifest = {
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
    ...(typeof raw["priority"] === "number" ? { priority: raw["priority"] } : {}),
    ...(raw["settings"] && typeof raw["settings"] === "object"
      ? { settings: raw["settings"] as NonNullable<PluginFileManifest["settings"]> }
      : {}),
  };
  const file = makePluginFile(manifest, checked.code);
  const body = JSON.stringify(file);
  // The file must read back as a valid plugin file, so a manifest problem shows here and not on the owner's site.
  const back = readPluginFile(body);
  if (!back.ok) return { ok: false, report: `${formatCheck(checked)}\nFAIL  ${back.message}` };
  const target = path.resolve(root, outFile ?? `${manifest.id}-${manifest.version}.oksplugin`);
  writeFileSync(target, body);
  return {
    ok: true,
    file: target,
    report: `${formatCheck(checked)}\nok    Wrote ${target}. Upload it in Tools > Plugins.`,
  };
}
