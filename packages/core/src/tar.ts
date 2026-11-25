// Reading a .tgz (a gzip-compressed tar) in memory, without writing a single file (spec 05, section 3.1). Nothing is trusted:
// the unpacked size is capped while it is unzipped (so a small file that grows huge is stopped), every header is checked,
// and every kind of entry that is not a plain file or a folder is reported as such, so the caller can refuse it.
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { once } from "node:events";
import { createGunzip, createGzip, gunzipSync, gzipSync, type Gzip } from "node:zlib";

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

function header(path: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(path.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.fill(32, 148, 156);
  h.write(type, 156);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}
const padded = (data: Buffer): Buffer =>
  Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);

/**
 * Writes plain files as a .tgz (the export of a theme). A path longer than the 100 bytes of a tar header gets a pax
 * header before it, which the reader above understands.
 */
export function writeTarGz(files: { path: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    if (Buffer.byteLength(file.path) > 100) {
      const body = ` path=${file.path}\n`;
      let length = Buffer.byteLength(body) + 1;
      while (Buffer.byteLength(`${length}${body}`) !== length)
        length = Buffer.byteLength(`${length}${body}`);
      const pax = Buffer.from(`${length}${body}`);
      parts.push(header("PaxHeader", pax.length, "x"), padded(pax));
    }
    parts.push(header(file.path, file.data.length, "0"), padded(file.data));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

// ------------------------------------------------------------------------------------------- big archives, one file at a time

/** The pieces of one entry, in order: a pax header when the path is long, the header, the data, and the padding. */
function entryParts(path: string, data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  if (Buffer.byteLength(path) > 100) {
    const body = ` path=${path}\n`;
    let length = Buffer.byteLength(body) + 1;
    while (Buffer.byteLength(`${length}${body}`) !== length)
      length = Buffer.byteLength(`${length}${body}`);
    const pax = Buffer.from(`${length}${body}`);
    parts.push(header("PaxHeader", pax.length, "x"), padded(pax));
  }
  parts.push(
    header(path, data.length, "0"),
    data,
    Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK),
  );
  return parts;
}

/**
 * Writes a .tgz to a file one entry at a time, so a site with gigabytes of pictures never holds them all in memory. Only one
 * entry's data is in memory at once, and it waits when the disk is slower than the writer.
 */
export class TarGzFileWriter {
  private readonly gzip: Gzip = createGzip();
  private readonly out: WriteStream;
  private readonly finished: Promise<void>;

  constructor(path: string) {
    this.out = createWriteStream(path, { mode: 0o600 });
    this.gzip.pipe(this.out);
    this.finished = new Promise<void>((resolve, reject) => {
      this.out.on("finish", resolve);
      this.out.on("error", reject);
      this.gzip.on("error", reject);
    });
    // A failure while nothing is waiting for it is reported by finish() or add(), not as an unhandled error.
    this.finished.catch(() => undefined);
  }

  private async push(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    if (!this.gzip.write(chunk)) await Promise.race([once(this.gzip, "drain"), this.finished]);
  }

  async add(path: string, data: Buffer): Promise<void> {
    for (const part of entryParts(path, data)) await this.push(part);
  }

  /** Closes the archive. Resolves when everything is on the disk. */
  async finish(): Promise<void> {
    await this.push(Buffer.alloc(BLOCK * 2));
    this.gzip.end();
    await this.finished;
  }

  /** Stops writing (a failure): the file is left for the caller to delete. */
  abort(): void {
    this.gzip.destroy();
    this.out.destroy();
  }
}

/** The most one entry of a big archive may hold (it is read into memory whole). */
export const BIG_ENTRY_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Reads a .tgz file entry by entry. Throws an Error with a plain message when the file is damaged, cut short or holds an entry
 * that is too big. Only plain files and folders are given; a link or device is an error. Paths are as written in the archive.
 */
export async function* readTarGzFile(
  path: string,
  maxEntryBytes: number = BIG_ENTRY_MAX_BYTES,
): AsyncGenerator<{ path: string; data: Buffer }> {
  const input = createReadStream(path).pipe(createGunzip());
  const chunks = input[Symbol.asyncIterator]();
  let held: Buffer[] = [];
  let have = 0;
  const take = async (n: number): Promise<Buffer | null> => {
    while (have < n) {
      let next: IteratorResult<Buffer>;
      try {
        next = await chunks.next();
      } catch {
        throw new Error("The file is damaged and cannot be unzipped.");
      }
      if (next.done) return have === 0 && n > 0 ? null : fail("The archive is cut short.");
      held.push(next.value);
      have += next.value.length;
    }
    const all = held.length === 1 ? held[0]! : Buffer.concat(held, have);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    held = rest.length > 0 ? [rest] : [];
    have = rest.length;
    return out;
  };
  const fail = (message: string): never => {
    throw new Error(message);
  };
  try {
    let nextPath: string | null = null;
    for (;;) {
      const head = await take(BLOCK);
      if (head === null || head.every((byte) => byte === 0)) return;
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : head[i]!;
      if (sum !== Number.parseInt(text(head, 148, 8).trim(), 8))
        fail("The archive is damaged (a header does not add up).");
      if ((head[124]! & 0x80) !== 0)
        fail("The archive has a file size in a form that is not supported.");
      const size = Number.parseInt(text(head, 124, 12).trim() || "0", 8);
      if (!Number.isInteger(size) || size < 0)
        fail("The archive is damaged (a file size is not a number).");
      if (size > maxEntryBytes) fail("A file in the archive is too big.");
      const data =
        size === 0 ? Buffer.alloc(0) : ((await take(size)) ?? fail("The archive is cut short."));
      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      if (pad > 0) await take(pad);
      const type = String.fromCharCode(head[156] || 48);
      if (type === "g" || type === "K") continue;
      if (type === "x") {
        nextPath = paxPath(data) ?? nextPath;
        continue;
      }
      if (type === "L") {
        nextPath = text(data, 0, data.length);
        continue;
      }
      let entry = nextPath;
      nextPath = null;
      if (entry === null) {
        const name = text(head, 0, 100);
        const prefix = text(head, 345, 155);
        entry = prefix && text(head, 257, 5) === "ustar" ? `${prefix}/${name}` : name;
      }
      if (entry.startsWith("./")) entry = entry.slice(2);
      if (type === "5") continue; // a folder
      if (type !== "0") fail("The archive holds a link or a special file, which is not allowed.");
      if (entry === "" || entry === ".") continue;
      yield { path: entry, data: Buffer.from(data) };
    }
  } finally {
    input.destroy();
  }
}
