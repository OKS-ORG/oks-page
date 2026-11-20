// `oks publish` (spec 10, section 7): sends an exported site to a place, sending only what changed and in an order that
// leaves a working site at every stop point. The places are small objects (`PublishTarget`): this file has a folder and a
// zip file; the others (SFTP, GitHub Pages, Cloudflare Pages, Netlify, S3) are made the same way.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

/** The files of a site and a hash of each: what was published, or what is about to be. */
export interface Manifest {
  v: 1;
  /** Path (always with `/`, from the site's root) to the sha256 of the file, as hex. */
  files: Record<string, string>;
}

export type PublishOp =
  | { kind: "put"; path: string; hash: string; phase: "files" | "pages" }
  | { kind: "delete"; path: string };

/** The file that tells the next publish what this one sent. Written last, and never part of the site. */
export const MANIFEST_FILE = ".oks-publish.json";

/** A page is an HTML file: visitors reach it by its address. Everything else (pictures, styles, scripts, the search index,
 * redirect files) is a file that pages point to. */
const isPage = (path: string): boolean => path.endsWith(".html");

/** True for a path that is safe to send: relative, with `/` only, no `..`, no empty or hidden-in-the-root tricks. */
export function isSafePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0"))
    return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Reads a folder into a manifest. Links and anything that is not a plain file are left out. */
export function manifestOf(dir: string): Manifest {
  const root = resolve(dir);
  const files: Record<string, string> = {};
  const walk = (folder: string, prefix: string) => {
    for (const name of readdirSync(folder).sort()) {
      const full = join(folder, name);
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const info = lstatSync(full);
      if (info.isDirectory()) walk(full, path);
      else if (info.isFile() && path !== MANIFEST_FILE)
        files[path] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root, "");
  return { v: 1, files };
}

/**
 * What to do to turn the published site into the new one, in the order that never leaves a broken site (ST-18 to ST-21):
 * (1) new and changed files that are not pages, (2) new and changed pages, (3) delete what no longer exists. A page is
 * never visible before the files it points to, and a file is never deleted while an old page may still point to it.
 * Only files whose hash changed are sent; with nothing published before, everything is sent.
 */
export function planPublish(next: Manifest, previous: Manifest | null): PublishOp[] {
  const before = previous?.files ?? {};
  const changed = Object.entries(next.files)
    .filter(([path, hash]) => before[path] !== hash)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const ops: PublishOp[] = [];
  for (const [path, hash] of changed)
    if (!isPage(path)) ops.push({ kind: "put", path, hash, phase: "files" });
  for (const [path, hash] of changed)
    if (isPage(path)) ops.push({ kind: "put", path, hash, phase: "pages" });
  for (const path of Object.keys(before).sort())
    if (!(path in next.files)) ops.push({ kind: "delete", path });
  return ops;
}

/** A place a site can be published to. */
export interface PublishTarget {
  /** What this place says it already has (a manifest written by an earlier publish), or null. */
  previous(): Promise<Manifest | null>;
  /** Writes one file. It must be whole or not there at all: never half a file. */
  put(path: string, bytes: Buffer): Promise<void>;
  remove(path: string): Promise<void>;
  /** Called last, when every operation was done: the place records what it now holds. */
  finish(manifest: Manifest): Promise<void>;
  /** Called when the publish is over, whether it went well or not: the place lets go of its connection. */
  close?(): Promise<void>;
}

export interface PublishReport {
  ok: boolean;
  /** The operations that were done, in order. */
  done: PublishOp[];
  /** How many operations the plan had. */
  planned: number;
  /** When it stopped: what went wrong, in plain words. */
  problem?: string;
}

/** Sends a folder to a target. Stops at the first problem and says how far it got; nothing is rolled back, because every stop point is a working site. */
export async function publishSite(
  dir: string,
  target: PublishTarget,
  options: { onStep?: (op: PublishOp) => void } = {},
): Promise<PublishReport> {
  try {
    return await publishInner(dir, target, options);
  } finally {
    // The place lets go of its connection, whatever happened.
    await target.close?.().catch(() => undefined);
  }
}

async function publishInner(
  dir: string,
  target: PublishTarget,
  options: { onStep?: (op: PublishOp) => void },
): Promise<PublishReport> {
  const root = resolve(dir);
  const next = manifestOf(root);
  for (const path of Object.keys(next.files))
    if (!isSafePath(path))
      return {
        ok: false,
        done: [],
        planned: 0,
        problem: `The file name "${path}" is not safe to publish.`,
      };
  let previous: Manifest | null;
  try {
    previous = await target.previous();
  } catch (error) {
    return {
      ok: false,
      done: [],
      planned: 0,
      problem: `The place could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const ops = planPublish(next, previous);
  const done: PublishOp[] = [];
  for (const op of ops) {
    try {
      if (op.kind === "put")
        await target.put(op.path, readFileSync(join(root, ...op.path.split("/"))));
      else await target.remove(op.path);
    } catch (error) {
      return {
        ok: false,
        done,
        planned: ops.length,
        problem: `${op.kind === "put" ? "Sending" : "Deleting"} ${op.path} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    done.push(op);
    options.onStep?.(op);
  }
  try {
    await target.finish(next);
  } catch (error) {
    return {
      ok: false,
      done,
      planned: ops.length,
      problem: `The files were sent, but the record of them could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, done, planned: ops.length };
}

// ---- a folder ----

/** A folder on this computer (a web server's folder, or a mounted drive). Each file is written under a temporary name and renamed. */
export function folderTarget(folder: string): PublishTarget {
  const root = resolve(folder);
  const inside = (path: string): string => {
    if (!isSafePath(path)) throw new Error(`"${path}" is not a safe file name`);
    const full = resolve(root, ...path.split("/"));
    if (full !== root && !full.startsWith(root + sep))
      throw new Error(`"${path}" is outside the folder`);
    return full;
  };
  return {
    async previous() {
      const file = join(root, MANIFEST_FILE);
      if (!existsSync(file)) return null;
      try {
        const m = JSON.parse(readFileSync(file, "utf8")) as Manifest;
        return m.v === 1 && m.files && typeof m.files === "object" ? m : null;
      } catch {
        return null;
      }
    },
    async put(path, bytes) {
      const full = inside(path);
      mkdirSync(dirname(full), { recursive: true });
      const temp = `${full}.oks-part`;
      writeFileSync(temp, bytes);
      renameSync(temp, full);
    },
    async remove(path) {
      rmSync(inside(path), { force: true });
    },
    async finish(manifest) {
      mkdirSync(root, { recursive: true });
      const temp = join(root, `${MANIFEST_FILE}.oks-part`);
      writeFileSync(temp, JSON.stringify(manifest));
      renameSync(temp, join(root, MANIFEST_FILE));
    },
  };
}

// ---- a zip file ----

/** A zip archive of files (deflate, no encryption, fixed dates so the same site always gives the same bytes). */
export function zipOf(files: { path: string; data: Buffer }[]): Buffer {
  // 1 January 2026, 00:00 in DOS time and date.
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const name = Buffer.from(file.path, "utf8");
    const packed = deflateRawSync(file.data);
    const useDeflate = packed.length < file.data.length;
    const body = useDeflate ? packed : file.data;
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** A zip file: the whole site every time (a zip has no record of an earlier publish). */
export function zipTarget(file: string): PublishTarget {
  const held = new Map<string, Buffer>();
  return {
    async previous() {
      return null;
    },
    async put(path, bytes) {
      if (!isSafePath(path)) throw new Error(`"${path}" is not a safe file name`);
      held.set(path, bytes);
    },
    async remove(path) {
      held.delete(path);
    },
    async finish() {
      const target = resolve(file);
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.oks-part`;
      writeFileSync(temp, zipOf([...held].map(([path, data]) => ({ path, data }))));
      renameSync(temp, target);
    },
  };
}
