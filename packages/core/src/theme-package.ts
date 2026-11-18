// Checking a theme package (spec 05, sections 3, 4, 7 and 8). A theme is a .tgz that holds data only: JSON, one CSS file,
// fonts and pictures. It is read in memory and judged piece by piece; nothing is unpacked, stored or run until every check
// has passed. The answer is a report in plain words (what passed, warnings, what was refused) and, when nothing was
// refused, the checked theme.
import { checkBlocks, type Block } from "@oks-page/content-safety";
import { checkThemeCss, describeCssProblems, THEME_CSS_MAX_BYTES } from "./css-check.js";
import { readTarGz } from "./tar.js";
import { FONT_CHOICES, checkTokens, isLibraryFont, parseHex, type ThemeTokens } from "./theme.js";

export const PACKAGE_MAX_FILES = 500;
export const PACKAGE_MAX_UNPACKED_BYTES = 20 * 1024 * 1024;
export const PACKAGE_MAX_PATH = 200;
/** The most blocks a layout may become once every part in it is put in its place (spec 05, section 7.1). */
export const MAX_EXPANDED_BLOCKS = 5000;
export const MAX_PART_DEPTH = 6;
const JSON_MAX_BYTES = 1024 * 1024;

/** The blocks that pull in live data from the site (spec 05, section 7). */
export const SITE_BLOCKS = [
  "site-logo",
  "site-title",
  "menu",
  "post-title",
  "post-content",
  "post-meta",
  "post-featured-image",
  "query-loop",
  "pagination",
  "search-form",
  "breadcrumbs",
  "part",
  "section",
  // A saved section of the site, placed by reference (spec 05, 17.10); a theme package has none of its own.
  "linked-section",
] as const;

/**
 * The groups of the section library (spec 05, section 17.5), in the order the library shows them. A theme names the
 * group of each section with `"group"` in its file; a section without one, or with an unknown one, is under "other".
 */
export const SECTION_GROUPS = [
  "hero",
  "text",
  "pictures",
  "gallery",
  "prices",
  "reviews",
  "team",
  "contact",
  "map",
  "call-to-action",
  "blog-posts",
  "other",
] as const;
export type SectionGroup = (typeof SECTION_GROUPS)[number];
/** The group names the owner sees. */
export const SECTION_GROUP_LABELS: Record<SectionGroup, string> = {
  hero: "Hero",
  text: "Text",
  pictures: "Pictures",
  gallery: "Gallery",
  prices: "Prices",
  reviews: "Reviews",
  team: "Team",
  contact: "Contact",
  map: "Map",
  "call-to-action": "Call to action",
  "blog-posts": "Blog posts",
  other: "Other",
};
const GROUPS = new Set<string>(SECTION_GROUPS);
/** The group of a stored section, "other" when it has none (themes installed before groups existed). */
export const sectionGroup = (value: unknown): SectionGroup =>
  typeof value === "string" && GROUPS.has(value) ? (value as SectionGroup) : "other";

const ALLOWED_EXTENSIONS = new Set([
  "json",
  "css",
  "woff2",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "avif",
  "md",
  "txt",
]);
const CODE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "ts",
  "php",
  "html",
  "htm",
  "svg",
  "xml",
  "sh",
  "exe",
  "wasm",
]);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const FONT_FAMILY = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,59}$/u;
/** CSS that points at a side of the page rather than the start or the end: a warning for right-to-left sites (spec 12). */
const PHYSICAL =
  /(?:margin|padding)-(?:left|right)\s*:|(?:^|[{;\s])(?:left|right)\s*:|float\s*:\s*(?:left|right)|text-align\s*:\s*(?:left|right)|border-(?:left|right)(?:-[a-z]+)?\s*:|border-(?:top|bottom)-(?:left|right)-radius\s*:/gi;

export interface ThemeFont {
  family: string;
  weight: number;
  style: "normal" | "italic";
  /** A woff2 file in the package. */
  file: string;
}

/** A named set of option values ("Warm", "Bold"): picking it fills the owner's look, which the owner can still change. */
export interface ThemePreset {
  name: string;
  values: { mainColor?: string; bodyFont?: string; headingFont?: string };
}

export const MAX_PRESETS = 8;
export const MAX_STARTER_PAGES = 12;
const PRESET_OPTIONS = ["mainColor", "bodyFont", "headingFont"] as const;

export interface ThemeLayout {
  name: string;
  title: string;
  blocks: Block[];
  /** For a starter page: a page or a post. */
  type?: "page" | "post";
  /** For a ready-made section (a pattern): its group in the section library. */
  group?: SectionGroup;
}

export interface CheckedTheme {
  key: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  rtl: "supported" | "untested";
  tokens: ThemeTokens;
  fonts: ThemeFont[];
  /** What an owner may change of this theme: "mainColor", "bodyFont", "headingFont", "logo". */
  options: string[];
  /** Named sets of option values the owner can start from. */
  presets: ThemePreset[];
  /** Sample pages the owner may add as drafts when using the theme. */
  starter: ThemeLayout[];
  /** The checked CSS, without comments (empty when the theme has none). */
  css: string;
  templates: ThemeLayout[];
  parts: ThemeLayout[];
  patterns: ThemeLayout[];
  /** Every file that may be served (fonts, pictures), by its path in the package. */
  assets: Map<string, Buffer>;
}

export interface PackageReport {
  /** What was checked and passed, in plain words. */
  passed: string[];
  /** Things worth knowing that do not stop the theme. */
  warnings: string[];
  /** Why the theme cannot be used. Empty when it can. */
  refused: string[];
}

export type PackageCheck =
  { ok: true; theme: CheckedTheme; report: PackageReport } | { ok: false; report: PackageReport };

const OPTION_NAMES = ["mainColor", "bodyFont", "headingFont", "logo"];

/** Why a path inside a package cannot be used, or null. */
export function badPackagePath(path: string): string | null {
  if (path.length > PACKAGE_MAX_PATH)
    return `the path is longer than ${PACKAGE_MAX_PATH} characters`;
  if (path.includes("\\")) return "the path has a backslash";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "the path has a control character";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "the path is absolute";
  for (const part of path.split("/")) {
    if (part === "") return "the path has an empty part";
    if (part === "." || part === "..") return 'the path has "." or ".." in it';
  }
  return null;
}

const extensionOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
};

/** The content type to serve a theme file with, by its extension. */
export const assetMimeType = (path: string): string =>
  ({
    woff2: "font/woff2",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    avif: "image/avif",
  })[extensionOf(path)] ?? "application/octet-stream";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks a theme package given as the bytes of a .tgz. Never throws. */
export function checkThemePackage(archive: Buffer): PackageCheck {
  const report: PackageReport = { passed: [], warnings: [], refused: [] };
  const refuse = (message: string) => {
    if (report.refused.length < 50) report.refused.push(message);
  };
  const warn = (message: string) => {
    if (report.warnings.length < 50) report.warnings.push(message);
  };
  const fail = (): PackageCheck => ({ ok: false, report });

  const tar = readTarGz(archive, PACKAGE_MAX_UNPACKED_BYTES + 2 * 1024 * 1024);
  if (!tar.ok) {
    refuse(tar.error);
    return fail();
  }

  // ----- the files: kinds, paths, types, counts, sizes
  let entries = tar.entries;
  for (const entry of entries)
    if (entry.kind === "other")
      refuse(`${entry.path}: links, devices and other special entries are not allowed.`);
  entries = entries.filter((e) => e.kind === "file");
  // A package made by `npm pack` keeps everything in one folder called "package".
  if (
    !entries.some((e) => e.path === "theme.json") &&
    entries.length > 0 &&
    entries.every((e) => e.path.startsWith("package/"))
  )
    entries = entries.map((e) => ({ ...e, path: e.path.slice("package/".length) }));

  if (entries.length > PACKAGE_MAX_FILES)
    refuse(`There are ${entries.length} files; the most allowed is ${PACKAGE_MAX_FILES}.`);
  const total = entries.reduce((sum, e) => sum + e.data.length, 0);
  if (total > PACKAGE_MAX_UNPACKED_BYTES)
    refuse(
      `The files add up to ${Math.ceil(total / 1024 / 1024)} MB; the most allowed is ${PACKAGE_MAX_UNPACKED_BYTES / 1024 / 1024} MB.`,
    );
  const seen = new Set<string>();
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const why = badPackagePath(entry.path);
    if (why) {
      refuse(`${entry.path.slice(0, 80)}: ${why}.`);
      continue;
    }
    if (seen.has(entry.path)) {
      refuse(`${entry.path}: the file is in the package twice.`);
      continue;
    }
    seen.add(entry.path);
    const extension = extensionOf(entry.path);
    if (extension === "") refuse(`${entry.path}: a file needs an extension.`);
    else if (CODE_EXTENSIONS.has(extension))
      refuse(`${entry.path}: code and markup (.${extension}) are not allowed in a theme.`);
    else if (!ALLOWED_EXTENSIONS.has(extension))
      refuse(`${entry.path}: .${extension} files are not allowed.`);
    else files.set(entry.path, entry.data);
  }
  if (report.refused.length > 0) return fail();
  report.passed.push(`${files.size} files, all of allowed kinds, with safe paths.`);

  // ----- theme.json
  const readJson = (path: string): unknown => {
    const data = files.get(path);
    if (!data) return undefined;
    if (data.length > JSON_MAX_BYTES) {
      refuse(`${path}: the file is larger than 1 MB.`);
      return undefined;
    }
    try {
      return JSON.parse(data.toString("utf8"));
    } catch {
      refuse(`${path}: the file is not valid JSON.`);
      return undefined;
    }
  };
  const manifest = readJson("theme.json");
  if (manifest === undefined && !files.has("theme.json"))
    refuse("There is no theme.json at the top of the package.");
  if (report.refused.length > 0) return fail();
  if (!isRecord(manifest)) {
    refuse("theme.json must be an object.");
    return fail();
  }
  const text = (name: string, max: number, required = false): string => {
    const value = manifest[name];
    if (value === undefined && !required) return "";
    if (typeof value !== "string" || value.trim() === "" || Array.from(value).length > max) {
      refuse(`theme.json: "${name}" must be text of 1 to ${max} characters.`);
      return "";
    }
    return value.trim();
  };
  const key = text("key", 64, true);
  if (key && !NAME.test(key))
    refuse('theme.json: "key" must be lower-case letters, digits and hyphens.');
  const name = text("name", 60, true);
  const version = text("version", 40, true);
  if (version && !VERSION.test(version)) refuse('theme.json: "version" must look like 1.2.3.');
  const description = text("description", 300);
  const author = text("author", 100);
  const license = text("license", 60);
  const rtlValue = manifest["rtl"];
  if (rtlValue !== undefined && rtlValue !== "supported" && rtlValue !== "untested")
    refuse('theme.json: "rtl" must be "supported" or "untested".');
  const rtl = rtlValue === "supported" ? "supported" : "untested";
  const packageJson = readJson("package.json");
  if (
    isRecord(packageJson) &&
    isRecord(packageJson["oksPage"]) &&
    packageJson["oksPage"]["type"] !== "theme"
  )
    refuse('package.json: "oksPage.type" must be "theme".');

  const tokenCheck =
    manifest["tokens"] === undefined
      ? { ok: true as const, tokens: {} }
      : checkTokens(manifest["tokens"]);
  if (!tokenCheck.ok) for (const error of tokenCheck.errors) refuse(`theme.json: ${error}`);
  const tokens: ThemeTokens = tokenCheck.ok ? tokenCheck.tokens : {};

  const options: string[] = [];
  if (manifest["options"] !== undefined) {
    if (!Array.isArray(manifest["options"])) refuse('theme.json: "options" must be a list.');
    else
      for (const option of manifest["options"] as unknown[]) {
        if (typeof option !== "string" || !OPTION_NAMES.includes(option))
          refuse(
            `theme.json: "${String(option).slice(0, 40)}" is not something an owner can change (${OPTION_NAMES.join(", ")}).`,
          );
        else if (!options.includes(option)) options.push(option);
      }
  }

  const presets: ThemePreset[] = [];
  if (manifest["presets"] !== undefined) {
    if (!Array.isArray(manifest["presets"]) || manifest["presets"].length > MAX_PRESETS)
      refuse(`theme.json: "presets" must be a list of at most ${MAX_PRESETS}.`);
    else
      for (const raw of manifest["presets"] as unknown[]) {
        const presetName =
          isRecord(raw) && typeof raw["name"] === "string" ? raw["name"].trim() : "";
        if (!isRecord(raw) || !presetName || presetName.length > 40) {
          refuse("theme.json: each preset needs a name of at most 40 characters.");
          continue;
        }
        if (presets.some((p) => p.name === presetName)) {
          refuse(`theme.json: two presets are called "${presetName}".`);
          continue;
        }
        const given = isRecord(raw["values"]) ? raw["values"] : null;
        if (!given || Object.keys(given).length === 0) {
          refuse(`theme.json: the preset "${presetName}" needs "values".`);
          continue;
        }
        const values: ThemePreset["values"] = {};
        for (const [option, value] of Object.entries(given)) {
          if (!(PRESET_OPTIONS as readonly string[]).includes(option))
            refuse(
              `theme.json: the preset "${presetName}" sets "${option.slice(0, 40)}", which a preset cannot change (${PRESET_OPTIONS.join(", ")}).`,
            );
          else if (!options.includes(option))
            refuse(
              `theme.json: the preset "${presetName}" sets ${option}, but the theme does not let owners change it ("options").`,
            );
          else if (option === "mainColor") {
            if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) && parseHex(value))
              values.mainColor = value.toLowerCase();
            else
              refuse(
                `theme.json: the main color of the preset "${presetName}" must look like #2a6f4f.`,
              );
          } else if (
            typeof value === "string" &&
            ((FONT_CHOICES as string[]).includes(value) || isLibraryFont(value))
          )
            values[option as "bodyFont" | "headingFont"] = value;
          else
            refuse(
              `theme.json: the ${option} of the preset "${presetName}" must be a system font or a font of the library.`,
            );
        }
        presets.push({ name: presetName, values });
      }
  }

  const fonts: ThemeFont[] = [];
  if (manifest["fonts"] !== undefined) {
    if (!Array.isArray(manifest["fonts"]) || manifest["fonts"].length > 20)
      refuse('theme.json: "fonts" must be a list of at most 20.');
    else
      for (const raw of manifest["fonts"] as unknown[]) {
        if (!isRecord(raw)) {
          refuse("theme.json: a font entry must be an object.");
          continue;
        }
        const family = raw["family"];
        const file = raw["file"];
        const weight = raw["weight"] === undefined ? 400 : raw["weight"];
        const style = raw["style"] === undefined ? "normal" : raw["style"];
        if (typeof family !== "string" || !FONT_FAMILY.test(family))
          refuse("theme.json: a font needs a plain family name.");
        else if (typeof file !== "string" || !file.endsWith(".woff2") || !files.has(file))
          refuse(`theme.json: the font "${family}" needs a .woff2 file that is in the package.`);
        else if (
          typeof weight !== "number" ||
          !Number.isInteger(weight) ||
          weight < 100 ||
          weight > 900 ||
          weight % 100 !== 0
        )
          refuse(`theme.json: the weight of "${family}" must be 100, 200 ... 900.`);
        else if (style !== "normal" && style !== "italic")
          refuse(`theme.json: the style of "${family}" must be "normal" or "italic".`);
        else fonts.push({ family, weight, style, file });
      }
  }
  // Every file named in the manifest must be a file of an allowed kind that exists; unknown keys are only mentioned.
  const known = new Set([
    "key",
    "name",
    "version",
    "description",
    "author",
    "license",
    "rtl",
    "tokens",
    "options",
    "presets",
    "fonts",
  ]);
  for (const k of Object.keys(manifest))
    if (!known.has(k)) warn(`theme.json: "${k}" is not used by this version.`);

  // ----- the CSS
  let css = "";
  const cssBytes = files.get("styles/theme.css");
  for (const path of files.keys())
    if (path.endsWith(".css") && path !== "styles/theme.css")
      warn(`${path}: only styles/theme.css is used.`);
  if (cssBytes) {
    const checked = checkThemeCss(cssBytes.toString("utf8"), {
      maxBytes: THEME_CSS_MAX_BYTES,
      allowFontFace: true,
      themeFiles: true,
    });
    if (!checked.ok) refuse(`styles/theme.css: ${describeCssProblems(checked.errors)}`);
    else {
      css = checked.css;
      for (const file of checked.files)
        if (!files.has(file) || !/\.(?:png|jpe?g|webp|avif|woff2)$/i.test(file))
          refuse(`styles/theme.css: the file "${file}" is not a picture or font in the package.`);
      const physical = new Set<string>();
      for (const match of css.matchAll(PHYSICAL))
        physical.add(
          match[0]
            .replace(/^[{;\s]+/, "")
            .replace(/\s*:$/, "")
            .toLowerCase(),
        );
      if (physical.size > 0)
        warn(
          `styles/theme.css uses ${[...physical].slice(0, 6).join(", ")}${physical.size > 6 ? " and more" : ""}: these point to the left or the right and read wrongly on right-to-left sites. Use the start and end forms instead.`,
        );
    }
  }
  if (report.refused.length > 0) return fail();
  report.passed.push(
    css ? "The CSS has no code, no outside addresses and no tricks." : "The theme has no CSS file.",
  );

  // ----- the layouts: templates, parts, patterns
  const layouts = (folder: string): ThemeLayout[] => {
    const out: ThemeLayout[] = [];
    for (const path of [...files.keys()].sort()) {
      if (!path.startsWith(`${folder}/`)) continue;
      const rest = path.slice(folder.length + 1);
      if (rest.includes("/") || !rest.endsWith(".json")) {
        warn(`${path}: only .json files directly in ${folder}/ are used.`);
        continue;
      }
      const layoutName = rest.slice(0, -5);
      if (!NAME.test(layoutName)) {
        refuse(`${path}: the name must be lower-case letters, digits and hyphens.`);
        continue;
      }
      const raw = readJson(path);
      if (raw === undefined) continue;
      if (!isRecord(raw) || !Array.isArray(raw["blocks"])) {
        refuse(`${path}: it must be an object with a list of "blocks".`);
        continue;
      }
      const checked = checkBlocks({ version: 1, blocks: raw["blocks"] });
      if (checked.repairs.length > 0)
        warn(
          `${path}: ${checked.repairs.length} thing${checked.repairs.length === 1 ? " was" : "s were"} repaired by the block checks (unsafe links, bad names or sizes).`,
        );
      const title = typeof raw["title"] === "string" ? raw["title"].slice(0, 100) : layoutName;
      if (folder === "starter") {
        out.push({
          name: layoutName,
          title,
          blocks: checked.body.blocks,
          type: raw["type"] === "post" ? "post" : "page",
        });
        continue;
      }
      if (folder !== "patterns") {
        out.push({ name: layoutName, title, blocks: checked.body.blocks });
        continue;
      }
      const group = sectionGroup(raw["group"]);
      if (raw["group"] !== undefined && group !== raw["group"])
        warn(
          `${path}: the group "${String(raw["group"]).slice(0, 40)}" is not one the library knows; the section is shown under "Other".`,
        );
      out.push({ name: layoutName, title, blocks: checked.body.blocks, group });
    }
    return out;
  };
  const templates = layouts("templates");
  const parts = layouts("parts");
  const patterns = layouts("patterns");
  const starter = layouts("starter");
  if (starter.length > MAX_STARTER_PAGES)
    refuse(`starter: a theme may bring at most ${MAX_STARTER_PAGES} sample pages.`);
  checkParts(templates, parts, refuse);
  if (report.refused.length > 0) return fail();
  if (templates.length + parts.length + patterns.length > 0)
    report.passed.push(
      `${templates.length} layouts, ${parts.length} header and footer parts and ${patterns.length} sections passed the block checks; every part exists and none includes itself.`,
    );
  if (presets.length > 0)
    report.passed.push(
      `${presets.length} preset${presets.length === 1 ? "" : "s"} set only options the theme lets owners change, with colors and fonts that are allowed.`,
    );
  if (starter.length > 0)
    report.passed.push(
      `${starter.length} sample page${starter.length === 1 ? "" : "s"} passed the block checks. They are added only when the owner asks, and only as drafts.`,
    );
  let unknownBlocks = 0;
  const countUnknown = (blocks: Block[]) => {
    for (const block of blocks) {
      if (!isBuiltIn(block.type)) unknownBlocks++;
      countUnknown(block.children);
    }
  };
  for (const layout of [...templates, ...parts, ...patterns]) countUnknown(layout.blocks);
  if (unknownBlocks > 0)
    warn(
      `${unknownBlocks} block${unknownBlocks === 1 ? "" : "s"} in the layouts ${unknownBlocks === 1 ? "is" : "are"} of kinds this site does not draw; they are kept and not shown.`,
    );

  const assets = new Map<string, Buffer>();
  for (const [path, data] of files)
    if (/\.(?:woff2|png|jpe?g|webp|avif)$/i.test(path)) assets.set(path, data);
  if (rtl === "untested") warn("The theme says it was not tested on right-to-left sites.");

  return {
    ok: true,
    theme: {
      key,
      name,
      version,
      description,
      author,
      license,
      rtl,
      tokens,
      fonts,
      options,
      presets,
      starter,
      css,
      templates,
      parts,
      patterns,
      assets,
    },
    report,
  };
}

const BUILT_IN_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "numberedList",
  "taskList",
  "quote",
  "callout",
  "toggle",
  "codeBlock",
  "divider",
  "image",
  "video",
  "embed",
  "table",
  "file",
  "bookmark",
  "columns",
]);
const isBuiltIn = (type: string): boolean =>
  BUILT_IN_TYPES.has(type) || (SITE_BLOCKS as readonly string[]).includes(type);

/** The names of the parts a list of blocks asks for (in order, with repeats). */
function partsIn(blocks: Block[], refuse: (message: string) => void, where: string): string[] {
  const out: string[] = [];
  const walk = (list: Block[]) => {
    for (const block of list) {
      if (block.type === "part") {
        const name = block.props["name"];
        if (typeof name !== "string" || !NAME.test(name))
          refuse(`${where}: a part block needs a name.`);
        else out.push(name);
      }
      walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

const countBlocks = (blocks: Block[]): number =>
  blocks.reduce((sum, b) => sum + 1 + countBlocks(b.children), 0);

/**
 * Every part a layout asks for must exist; no part may include itself, directly or through other parts; and putting the
 * parts in place must not make more than `MAX_EXPANDED_BLOCKS` blocks, nor nest more than `MAX_PART_DEPTH` deep. The size
 * is worked out without ever building the big list (a few parts that each include the next twice would make millions).
 */
export function checkParts(
  templates: ThemeLayout[],
  parts: ThemeLayout[],
  refuse: (message: string) => void,
): void {
  const byName = new Map(parts.map((p) => [p.name, p]));
  const partAsks = new Map(parts.map((p) => [p.name, partsIn(p.blocks, refuse, p.name)]));
  const templateAsks = new Map(templates.map((t) => [t.name, partsIn(t.blocks, refuse, t.name)]));
  for (const asks of [partAsks, templateAsks])
    for (const [layoutName, names] of asks)
      for (const name of names)
        if (!byName.has(name)) refuse(`${layoutName}: the part "${name}" is not in the theme.`);

  const state = new Map<string, "visiting" | "done">();
  const size = new Map<string, number>();
  const depth = new Map<string, number>();
  const visit = (part: ThemeLayout): void => {
    if (state.get(part.name) === "done") return;
    state.set(part.name, "visiting");
    let blocks = countBlocks(part.blocks);
    let deepest = 0;
    for (const name of partAsks.get(part.name) ?? []) {
      const inner = byName.get(name);
      if (!inner) continue;
      if (state.get(name) === "visiting") {
        refuse(
          `${part.name}: the part includes itself${name === part.name ? "" : ` through "${name}"`}.`,
        );
        continue;
      }
      visit(inner);
      blocks = Math.min(MAX_EXPANDED_BLOCKS + 1, blocks + (size.get(name) ?? 0));
      deepest = Math.max(deepest, depth.get(name) ?? 0);
    }
    size.set(part.name, blocks);
    depth.set(part.name, deepest + 1);
    state.set(part.name, "done");
  };
  for (const part of parts) visit(part);
  for (const part of parts) {
    if ((size.get(part.name) ?? 0) > MAX_EXPANDED_BLOCKS)
      refuse(
        `${part.name}: with the parts in it put in place, it would have more than ${MAX_EXPANDED_BLOCKS} blocks.`,
      );
    if ((depth.get(part.name) ?? 0) > MAX_PART_DEPTH)
      refuse(`${part.name}: parts are nested more than ${MAX_PART_DEPTH} levels deep.`);
  }
  for (const template of templates) {
    let blocks = countBlocks(template.blocks);
    let deepest = 0;
    for (const name of templateAsks.get(template.name) ?? []) {
      blocks = Math.min(MAX_EXPANDED_BLOCKS + 1, blocks + (size.get(name) ?? 0));
      deepest = Math.max(deepest, depth.get(name) ?? 0);
    }
    if (blocks > MAX_EXPANDED_BLOCKS)
      refuse(
        `${template.name}: with its parts put in place, it would have more than ${MAX_EXPANDED_BLOCKS} blocks.`,
      );
    if (deepest > MAX_PART_DEPTH)
      refuse(`${template.name}: parts are nested more than ${MAX_PART_DEPTH} levels deep.`);
  }
}
