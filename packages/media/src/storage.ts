// Spec 09 section 7: where files are kept. An adapter has five calls. Keys are
// never reused, so a file is never overwritten.

import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface StorageAdapter {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  publicUrl(key: string): string;
  /** Every key kept, in no set order (for moving files between storages). */
  list(): AsyncIterable<string>;
}

/** A key looks like `2026/10/<id>-<clean-name>.<ext>`. */
export function buildKey(id: string, fileName: string, now: Date = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}/${mm}/${id}-${fileName}`;
}

/** A key is refused when it could leave the uploads folder. */
export function assertSafeKey(key: string): void {
  if (
    key === "" ||
    key.includes("\0") ||
    key.includes("\\") ||
    key.startsWith("/") ||
    /^[a-zA-Z]:/.test(key) ||
    key.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new Error("That storage key is not allowed.");
  }
}

export interface LocalAdapterOptions {
  /** The folder the files live in. */
  root: string;
  /** The address the folder is served under, for example `/uploads`. */
  baseUrl?: string;
}

export function localAdapter(options: LocalAdapterOptions): StorageAdapter {
  const root = path.resolve(options.root);
  const baseUrl = (options.baseUrl ?? "/uploads").replace(/\/$/, "");

  const fileFor = (key: string): string => {
    assertSafeKey(key);
    const full = path.resolve(root, key);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error("That storage key is not allowed.");
    }
    return full;
  };

  // A link inside the folder that leads outside it must not be followed.
  const insideRoot = async (full: string): Promise<boolean> => {
    const realRoot = await realpath(root).catch(() => root);
    const real = await realpath(full);
    return real === realRoot || real.startsWith(realRoot + path.sep);
  };

  return {
    async put(key, bytes) {
      const full = fileFor(key);
      await mkdir(path.dirname(full), { recursive: true });
      // Written to a temporary file first, so a half-written file never stays.
      const temp = `${full}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temp, bytes, { flag: "wx" });
        await rename(temp, full);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    async get(key) {
      const full = fileFor(key);
      if (!(await insideRoot(full))) throw new Error("That storage key is not allowed.");
      return new Uint8Array(await readFile(full));
    },
    async delete(key) {
      await rm(fileFor(key), { force: true });
    },
    async exists(key) {
      try {
        const full = fileFor(key);
        if (!(await insideRoot(full))) return false;
        return (await stat(full)).isFile();
      } catch {
        return false;
      }
    },
    publicUrl(key) {
      assertSafeKey(key);
      return `${baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
    },
    async *list() {
      // Files only; links are never followed, and a temporary file of a write that is still going is left out.
      async function* walk(folder: string, prefix: string): AsyncGenerator<string> {
        let names: string[];
        try {
          names = await readdir(folder);
        } catch {
          return;
        }
        for (const name of names.sort()) {
          const full = path.join(folder, name);
          const info = await lstat(full);
          if (info.isDirectory()) yield* walk(full, `${prefix}${name}/`);
          else if (info.isFile() && !name.endsWith(".tmp")) yield `${prefix}${name}`;
        }
      }
      yield* walk(root, "");
    },
  };
}
