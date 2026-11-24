// The plugins that ship with the product (spec 16: Forms is installed in new sites). Each is packed from its folder in
// `apps/` into one plugin file that is kept in the product package, so a site can install it without a download. The
// file is made here the way `oks pack` makes it (the same manifest function, the same production build), and the
// repository check compares what is kept with what the source makes now.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The plugins shipped with the product: the folder of the source, and where the plugin file is kept. */
export const FIRST_PARTY = [
  { dir: "apps/forms-plugin", out: "packages/oks-page/src/forms-plugin-file.json" },
  { dir: "apps/business-plugin", out: "packages/oks-page/src/business-plugin-file.json" },
];

/** True when the packages this needs have been built (`tsc -b`). */
export const canBuild = (root) =>
  existsSync(join(root, "packages/cli/dist/plugin-manifest.js")) &&
  existsSync(join(root, "packages/sandbox/dist/index.js"));

/** The plugin file the source of one shipped plugin makes now, as the text that is kept. */
export async function expectedFile(root, dir) {
  const { pluginManifestOf } = await import(
    pathToFileURL(join(root, "packages/cli/dist/plugin-manifest.js")).href
  );
  const { makePluginFile } = await import(
    pathToFileURL(join(root, "packages/sandbox/dist/index.js")).href
  );
  const { build } = createRequire(join(root, "packages/cli/package.json"))("esbuild");
  const folder = join(root, dir);
  const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const entry = [pkg.oksPage?.entry, "src/index.ts", "src/index.js", "index.ts", "index.js"]
    .filter(Boolean)
    .map((e) => join(folder, e))
    .find((e) => existsSync(e));
  if (!entry) throw new Error(`${dir} has no entry file`);
  // The same options as `oks check` builds with.
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    minify: true,
    logLevel: "silent",
    absWorkingDir: folder,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return `${JSON.stringify(makePluginFile(pluginManifestOf(pkg), out.outputFiles[0].text))}\n`;
}
