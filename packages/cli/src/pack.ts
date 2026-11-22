// `oks pack [folder] [--out file]`: checks a plugin like `oks check` does, then writes the one file an owner uploads in
// Tools > Plugins: the manifest, the production bundle and the bundle's hash (spec 04, sections 3 and 10).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makePluginFile, readPluginFile } from "@oks-page/sandbox";
import { checkPlugin, formatCheck } from "./check.js";
import { pluginManifestOf } from "./plugin-manifest.js";

export interface PackResult {
  ok: boolean;
  /** What the command prints. */
  report: string;
  /** Where the file was written, when it was. */
  file?: string;
}

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
  const manifest = pluginManifestOf(pkg);
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
