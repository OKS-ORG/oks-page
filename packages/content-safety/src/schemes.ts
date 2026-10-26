// Which web addresses and colors are safe to store (spec 03, section 4).
/* eslint-disable no-control-regex -- matching control characters is the point: they are how a
   hostile address hides its real scheme (EC-07, EC-16). */

const ALLOWED_LINK_SCHEMES = new Set(["https", "http", "mailto", "tel"]);
const ALLOWED_VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com"];

/** Browsers tolerate control characters and whitespace before a scheme, so a trick such as
 * "jav\tascript:" or " javascript:" still runs. Stripping them first before reading the scheme
 * closes that gap, including leading spaces and hidden line breaks (EC-07). */
function cleanUrl(raw: string): string {
  return raw.replace(/[\u0000- ]+/g, "");
}

function readScheme(cleaned: string): string | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  return m ? m[1]!.toLowerCase() : null;
}

/** Links and non-video block URLs (href, image.src, file.src, embed.url, bookmark.url). */
export function isSafeUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  const cleaned = cleanUrl(raw);
  if (cleaned.length === 0) return false;
  // "//host" (protocol-relative) and "\\host" reach another host without naming a scheme.
  if (cleaned.startsWith("//") || cleaned.startsWith("\\")) return false;
  const scheme = readScheme(cleaned);
  if (scheme === null) return true; // a relative address: /about, #top, ?x, or a plain path
  return ALLOWED_LINK_SCHEMES.has(scheme);
}

/** Video sources: https only, and only from an allowed host (starts with YouTube and Vimeo). */
export function isSafeVideoUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  const cleaned = cleanUrl(raw);
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_COLOR_RE = /^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+%?\s*)?\)$/i;
const HSL_COLOR_RE =
  /^hsla?\(\s*[\d.]+(?:deg)?\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(?:,\s*[\d.]+%?\s*)?\)$/i;
// A short, safe list of CSS color names. Not exhaustive by design: an unrecognised name is
// refused rather than guessed at, and a hex or rgb()/hsl() value always works.
const CSS_COLOR_NAMES = new Set([
  "black",
  "white",
  "red",
  "green",
  "blue",
  "yellow",
  "orange",
  "purple",
  "pink",
  "brown",
  "gray",
  "grey",
  "cyan",
  "magenta",
  "lime",
  "navy",
  "teal",
  "maroon",
  "olive",
  "silver",
  "gold",
  "indigo",
  "violet",
  "coral",
  "salmon",
  "transparent",
  "currentcolor",
  "inherit",
]);

/** Only a hex color, rgb()/rgba(), hsl()/hsla(), or a known color name is kept (EC-02 to EC-04). */
export function isSafeColor(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (s.length === 0 || s.length > 64) return false;
  if (HEX_COLOR_RE.test(s)) return true;
  if (RGB_COLOR_RE.test(s)) return true;
  if (HSL_COLOR_RE.test(s)) return true;
  return CSS_COLOR_NAMES.has(s.toLowerCase());
}

const SCRIPT_LIKE_RE = /^[\u0000- ]*(javascript|data|vbscript)[\u0000- ]*:/i;

/** For unknown block types we cannot know which props are URLs, so instead any string that
 * looks like a script address is stripped, at any depth (EC-16). */
export function looksLikeScriptUrl(raw: unknown): boolean {
  return typeof raw === "string" && SCRIPT_LIKE_RE.test(cleanUrl(raw));
}
