// Reading a .tgz (a gzip-compressed tar) in memory, without writing a single file (spec 05, section 3.1). Nothing is trusted:
// the unpacked size is capped while it is unzipped (so a small file that grows huge is stopped), every header is checked,
// and every kind of entry that is not a plain file or a folder is reported as such, so the caller can refuse it.
import { gunzipSync } from "node:zlib";

export interface TarEntry {
  /** The path as written in the archive, with a leading "./" taken off. */
  path: string;
  /** "file", "dir", or "other" (a link, a device, a pipe...). */
  kind: "file" | "dir" | "other";
  /** The tar type character ("0" for a file, "2" for a symbolic link, ...). */
  type: string;
  data: Buffer;
}

export type TarResult = { ok: true; entries: TarEntry[] } | { ok: false; error: string };

const BLOCK = 512;
const text = (buffer: Buffer, start: number, length: number): string => {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
};

/** The `path` of a pax header ("27 path=some/long/name\n" records). */
function paxPath(data: Buffer): string | null {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(32, at);
    if (space < 0) return null;
    const length = Number.parseInt(data.subarray(at, space).toString("ascii"), 10);
    if (!Number.isInteger(length) || length <= space - at || at + length > data.length) return null;
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    if (record.startsWith("path=")) return record.slice(5);
    at += length;
  }
  return null;
}

/**
 * Reads a .tgz. `maxUnpackedBytes` caps the whole unzipped archive (file data plus the 512-byte headers), so a "bomb"
 * is stopped while it is being unzipped, long before it fills the memory.
 */
export function readTarGz(archive: Buffer, maxUnpackedBytes: number): TarResult {
  if (archive.length < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b)
    return { ok: false, error: "This is not a .tgz file (a gzip-compressed tar)." };
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxUnpackedBytes });
  } catch (error) {
    const code = (error as { code?: string }).code;
    return {
      ok: false,
      error:
        code === "ERR_BUFFER_TOO_LARGE"
          ? "The files are too large when unpacked."
          : "The file is damaged and cannot be unzipped.",
    };
  }
  const entries: TarEntry[] = [];
  let at = 0;
  let nextPath: string | null = null;
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    // The checksum: the sum of all bytes, with the checksum field counted as spaces.
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
    const stored = Number.parseInt(text(header, 148, 8).trim(), 8);
    if (sum !== stored)
      return { ok: false, error: "The archive is damaged (a header does not add up)." };
    if ((header[124]! & 0x80) !== 0)
      return { ok: false, error: "The archive has a file size in a form that is not supported." };
    const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
    if (!Number.isInteger(size) || size < 0)
      return { ok: false, error: "The archive is damaged (a file size is not a number)." };
    const dataStart = at + BLOCK;
    if (dataStart + size > tar.length) return { ok: false, error: "The archive is cut short." };
    const data = tar.subarray(dataStart, dataStart + size);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    const type = String.fromCharCode(header[156] || 48);
    if (type === "g" || type === "K") continue; // a global header, or a long link name: nothing to keep
    if (type === "x") {
      nextPath = paxPath(data) ?? nextPath;
      continue;
    }
    if (type === "L") {
      nextPath = text(data, 0, data.length);
      continue;
    }
    let path = nextPath;
    nextPath = null;
    if (path === null) {
      const name = text(header, 0, 100);
      const prefix = text(header, 345, 155);
      path = prefix && text(header, 257, 5) === "ustar" ? `${prefix}/${name}` : name;
    }
    if (path.startsWith("./")) path = path.slice(2);
    const kind = type === "0" ? "file" : type === "5" ? "dir" : "other";
    if (kind === "dir") path = path.replace(/\/+$/, "");
    if (path === "" || path === ".") continue; // the top folder itself
    entries.push({ path, kind, type, data: kind === "file" ? data : Buffer.alloc(0) });
  }
  return { ok: true, entries };
}
