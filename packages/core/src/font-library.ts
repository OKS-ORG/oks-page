// The built-in font library (ADR 0028, spec 05 section 6). A short list of free fonts (SIL Open Font Licence 1.1) that
// the site serves itself, so a visitor's browser never contacts another company. The list and the checks are pure; the
// files are in `font-files.ts`, which only the font route loads. This file has no database and no Node-only code, so
// the admin screens can use it too.
import { FONT_LIBRARY_LIST } from "./font-library-list.js";

export type FontKind = "sans" | "serif" | "mono";
export const FONT_KINDS = ["sans", "serif", "mono"] as const;

export interface LibraryFontFile {
  /** "latin" or "devanagari": the part of the alphabet the file holds. */
  script: string;
  weight: number;
  /** The fingerprint of the file; it is also its address, so a file never changes under its name. */
  sha256: string;
  bytes: number;
}

export interface LibraryFont {
  /** The value stored for a choice of font: lower case letters, digits and hyphens ("source-serif-4"). */
  key: string;
  /** The name CSS uses ("Source Serif 4"). */
  name: string;
  kind: FontKind;
  scripts: string[];
  package: string;
  version: string;
  /** The registry's fingerprint of the package the files came from. */
  integrity: string;
  license: "OFL-1.1";
  copyright: string;
  files: LibraryFontFile[];
}

export const FONT_LIBRARY: readonly LibraryFont[] = FONT_LIBRARY_LIST;

/** The font of a stored choice, or undefined (a system font, or a name that is not in the library). */
export const fontByKey = (key: string): LibraryFont | undefined =>
  FONT_LIBRARY.find((font) => font.key === key);

export const isLibraryFont = (key: unknown): key is string =>
  typeof key === "string" && fontByKey(key) !== undefined;

/** What the browser uses while the font loads, or when it cannot. */
export const FONT_FALLBACKS: Record<FontKind, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

/**
 * A font the owner uploaded is chosen by a key that carries what the page needs to draw it: `own-<kind>-<weight>-<16
 * letters of the file's fingerprint>`, weight being 400, 700 or `vf` (a font with every weight). Nothing else is needed
 * to write its rules, so the page code never has to look anything up.
 */
export const OWN_FONT_KEY = /^own-(sans|serif|mono)-(400|700|vf)-([0-9a-f]{16})$/;
export const isOwnFont = (key: unknown): key is string =>
  typeof key === "string" && OWN_FONT_KEY.test(key);
/** The name CSS uses for an owner's font: never the owner's own text. */
export const ownFontFamily = (key: string): string => `oks-${key}`;
export const ownFontStack = (key: string): string => {
  const m = OWN_FONT_KEY.exec(key);
  const kind = (m?.[1] ?? "sans") as FontKind;
  return `"${ownFontFamily(key)}", ${FONT_FALLBACKS[kind]}`;
};
export const ownFontUrl = (key: string): string => `/fonts/${key}.woff2`;
export const ownFontFaceCss = (key: string): string => {
  const m = OWN_FONT_KEY.exec(key);
  if (!m) return "";
  const weight = m[2] === "vf" ? "100 900" : m[2];
  return `@font-face{font-family:"${ownFontFamily(key)}";font-style:normal;font-weight:${weight};font-display:swap;src:url(${ownFontUrl(key)}) format("woff2")}`;
};

/** The CSS font-family value of a library font. */
export const libraryStack = (font: LibraryFont): string =>
  `"${font.name}", ${FONT_FALLBACKS[font.kind]}`;

/** The address of a file: `/fonts/inter-latin-400.<first 16 letters of its fingerprint>.woff2`. */
export const fontFileName = (font: LibraryFont, file: LibraryFontFile): string =>
  `${font.key}-${file.script}-${file.weight}.${file.sha256.slice(0, 16)}.woff2`;

export const fontFileUrl = (font: LibraryFont, file: LibraryFontFile): string =>
  `/fonts/${fontFileName(font, file)}`;

const FILE_NAME = /^([a-z0-9-]+)-([a-z]+)-(\d{3})\.([0-9a-f]{16})\.woff2$/;

/** The font and file an address means, or null when the name is not exactly one of the library's. */
export function fontFileByName(name: string): { font: LibraryFont; file: LibraryFontFile } | null {
  const m = FILE_NAME.exec(name);
  if (!m) return null;
  for (const font of FONT_LIBRARY) {
    const file = font.files.find(
      (f) =>
        font.key === `${m[1]}` &&
        f.script === m[2] &&
        String(f.weight) === m[3] &&
        f.sha256.startsWith(m[4]!),
    );
    if (file) return { font, file };
  }
  return null;
}

/** The part of the character set each file serves; the browser loads a file only when the page uses these letters. */
const UNICODE_RANGE: Record<string, string> = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  devanagari:
    "U+0900-097F,U+1CD0-1CF9,U+200C-200D,U+20A8,U+20B9,U+20F0,U+25CC,U+A830-A839,U+A8E0-A8FF,U+11B00-11B09",
};

/**
 * The `@font-face` rules for the library fonts among `keys` (any other value is skipped, a font once). Written from the
 * list only, so nothing typed by anyone reaches the style sheet. `font-display: swap` shows the text at once.
 */
export function fontFaceCss(keys: readonly string[]): string {
  const rules: string[] = [];
  for (const key of new Set(keys)) {
    if (isOwnFont(key)) {
      rules.push(ownFontFaceCss(key));
      continue;
    }
    const font = fontByKey(key);
    if (!font) continue;
    for (const file of font.files)
      rules.push(
        `@font-face{font-family:"${font.name}";font-style:normal;font-weight:${file.weight};font-display:swap;` +
          `src:url(${fontFileUrl(font, file)}) format("woff2");unicode-range:${UNICODE_RANGE[file.script] ?? UNICODE_RANGE["latin"]}}`,
      );
  }
  return rules.join("\n");
}

export const LICENSE_NAME = "SIL Open Font Licence, version 1.1";
export const LICENSE_URL = "https://openfontlicense.org";
