// Spec 09 sections 3 and 4: what may be uploaded. The type is read from the
// bytes, never from the file name, and the name must agree with it.

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_PIXELS = 100_000_000;

export type MediaKind = "image" | "pdf" | "video" | "audio" | "svg";

export interface FileType {
  mime: string;
  ext: string;
  kind: MediaKind;
}

const JPEG: FileType = { mime: "image/jpeg", ext: "jpg", kind: "image" };
const PNG: FileType = { mime: "image/png", ext: "png", kind: "image" };
const GIF: FileType = { mime: "image/gif", ext: "gif", kind: "image" };
const WEBP: FileType = { mime: "image/webp", ext: "webp", kind: "image" };
const AVIF: FileType = { mime: "image/avif", ext: "avif", kind: "image" };
const PDF: FileType = { mime: "application/pdf", ext: "pdf", kind: "pdf" };
const MP4: FileType = { mime: "video/mp4", ext: "mp4", kind: "video" };
const MP3: FileType = { mime: "audio/mpeg", ext: "mp3", kind: "audio" };
const SVG: FileType = { mime: "image/svg+xml", ext: "svg", kind: "svg" };

/** Other extensions that are fine for the same content. */
const ALSO_OK: Record<string, string[]> = {
  jpg: ["jpeg", "jpe"],
  mp4: ["m4v"],
  svg: [],
};

const ascii = (b: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...b.subarray(from, to));

const startsWith = (b: Uint8Array, bytes: number[]): boolean =>
  b.length >= bytes.length && bytes.every((v, i) => b[i] === v);

const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "heif",
]);

function looksLikeSvg(b: Uint8Array): boolean {
  // Only the start is looked at: an optional byte order mark, white space, an
  // optional xml line or comments, then the svg tag.
  let head = new TextDecoder("utf-8").decode(b.subarray(0, 2048));
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(
    head,
  );
}

/** Reads the type from the bytes. Returns `null` when it is not a type we know. */
export function detectType(bytes: Uint8Array): FileType | "heic" | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  const sig6 = ascii(bytes, 0, 6);
  if (sig6 === "GIF87a" || sig6 === "GIF89a") return GIF;
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return WEBP;
  if (ascii(bytes, 0, 5) === "%PDF-") return PDF;
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return AVIF;
    if (HEIC_BRANDS.has(brand)) return "heic";
    return MP4;
  }
  if (ascii(bytes, 0, 3) === "ID3") return MP3;
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe6) === 0xe2) return MP3;
  if (looksLikeSvg(bytes)) return SVG;
  return null;
}

/** Cleans a file name (spec 09 section 4). Returns the name without its extension and the extension. */
export function cleanFileName(name: string): { base: string; ext: string } {
  let n = name.normalize("NFC");
  // Folders and drive letters.
  n = n.replace(/^.*[\\/]/, "");
  // Control characters and the characters Windows forbids.
  n = [...n]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join("")
    .replace(/[<>:"|?*]/g, "");
  const dot = n.lastIndexOf(".");
  // Leading dots are removed, so a name can never be hidden or climb up.
  let base = (dot >= 0 ? n.slice(0, dot) : n).replace(/^\.+/, "");
  const ext = dot >= 0 ? n.slice(dot + 1).toLowerCase() : "";
  base = base.trim().replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = "_" + base;
  const cleanExt = ext.replace(/[^a-z0-9]/g, "");
  const room = Math.max(1, 120 - (cleanExt ? cleanExt.length + 1 : 0));
  base = [...base].slice(0, room).join("");
  return { base: base || "file", ext: cleanExt };
}

export interface CheckOptions {
  /** The person may upload SVG (capability media.upload_svg). */
  canUploadSvg: boolean;
  maxBytes?: number;
}

export type CheckResult =
  { ok: true; type: FileType; fileName: string } | { ok: false; reason: string };

const refuse = (reason: string): CheckResult => ({ ok: false, reason });

/** Checks one upload by its content. Nothing is stored here. */
export function checkUpload(name: string, bytes: Uint8Array, options: CheckOptions): CheckResult {
  const max = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.length === 0) return refuse("The file is empty.");
  if (bytes.length > max) {
    return refuse(
      `The file is too big. The most allowed is ${Math.floor(max / (1024 * 1024))} MB.`,
    );
  }
  const found = detectType(bytes);
  if (found === "heic") {
    return refuse(
      "HEIC photos are not supported yet. Please save or share the photo as a JPEG and upload that.",
    );
  }
  if (!found) return refuse("This kind of file is not allowed.");
  if (found.kind === "svg" && !options.canUploadSvg) {
    return refuse("You are not allowed to upload SVG files.");
  }
  const { base, ext } = cleanFileName(name);
  const fine = [found.ext, ...(ALSO_OK[found.ext] ?? [])];
  if (ext && !fine.includes(ext)) {
    return refuse(`The file says it is .${ext} but its content is ${found.mime}.`);
  }
  return { ok: true, type: found, fileName: `${base}.${found.ext}` };
}
