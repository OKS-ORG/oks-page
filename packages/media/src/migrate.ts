// Moving files between storages (spec 09, section 7): `oks media migrate --to s3` or `--to local`. Every file is copied
// and read back, and its fingerprint (SHA-256) must match before it counts. Nothing is ever deleted: the old storage
// keeps its files until the owner removes them. A file that is already there with the same bytes is left alone, so the
// command can run again after a break.
import { createHash } from "node:crypto";
import type { StorageAdapter } from "./storage.js";

export interface MigrateResult {
  copied: number;
  alreadyThere: number;
  failed: { key: string; reason: string }[];
}

const fingerprint = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function migrateFiles(
  from: StorageAdapter,
  to: StorageAdapter,
  progress: (done: number, key: string) => void = () => undefined,
): Promise<MigrateResult> {
  const result: MigrateResult = { copied: 0, alreadyThere: 0, failed: [] };
  let done = 0;
  for await (const key of from.list()) {
    try {
      const bytes = await from.get(key);
      const want = fingerprint(bytes);
      if (await to.exists(key)) {
        if (fingerprint(await to.get(key)) === want) {
          result.alreadyThere++;
          progress(++done, key);
          continue;
        }
        // Keys are never reused, so different bytes under the same key mean something is wrong: never overwrite.
        result.failed.push({ key, reason: "a different file with this name is already there" });
        progress(++done, key);
        continue;
      }
      await to.put(key, bytes);
      if (fingerprint(await to.get(key)) !== want)
        throw new Error("the copy does not match the original");
      result.copied++;
    } catch (error) {
      result.failed.push({ key, reason: (error as Error).message });
    }
    progress(++done, key);
  }
  return result;
}
