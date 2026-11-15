// Moving files between storages: every file copied and checked, nothing deleted, safe to run again. Between two folders
// always; between a folder and a real S3 service when S3_TEST_* is set (locally: SeaweedFS).
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migrateFiles } from "./migrate.js";
import { localAdapter, type StorageAdapter } from "./storage.js";
import { s3Adapter, s3Client } from "./storage-s3.js";

let dir: string;
let from: StorageAdapter;
let to: StorageAdapter;
const all = async (store: StorageAdapter) => {
  const keys: string[] = [];
  for await (const k of store.list()) keys.push(k);
  return keys.sort();
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "oks-migrate-"));
  from = localAdapter({ root: path.join(dir, "a") });
  to = localAdapter({ root: path.join(dir, "b") });
  await from.put("2026/11/x-photo.jpg", new Uint8Array([1, 2, 3]));
  await from.put("2026/11/x-photo-640.webp", new Uint8Array([4, 5]));
  await from.put("themes/abc.css", new TextEncoder().encode("body{}"));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe("moving files between storages", () => {
  test("the local list has every file and leaves out links and temporary files", async () => {
    await writeFile(path.join(dir, "a", "2026", "11", "half.png.abc123.tmp"), "x");
    await mkdir(path.join(dir, "outside"));
    await writeFile(path.join(dir, "outside", "secret.txt"), "secret");
    await symlink(path.join(dir, "outside"), path.join(dir, "a", "link"));
    expect(await all(from)).toEqual([
      "2026/11/x-photo-640.webp",
      "2026/11/x-photo.jpg",
      "themes/abc.css",
    ]);
  });

  test("every file is copied and checked; the old storage keeps its files; a second run copies nothing", async () => {
    const first = await migrateFiles(from, to);
    expect(first).toEqual({ copied: 3, alreadyThere: 0, failed: [] });
    expect(await all(to)).toEqual(await all(from));
    expect([...(await to.get("2026/11/x-photo.jpg"))]).toEqual([1, 2, 3]);
    expect(await all(from)).toHaveLength(3);
    expect(await migrateFiles(from, to)).toEqual({ copied: 0, alreadyThere: 3, failed: [] });
  });

  test("a different file under the same name is never overwritten", async () => {
    await to.put("themes/abc.css", new TextEncoder().encode("changed"));
    const result = await migrateFiles(from, to);
    expect(result.copied).toBe(2);
    expect(result.failed).toEqual([
      { key: "themes/abc.css", reason: "a different file with this name is already there" },
    ]);
    expect(new TextDecoder().decode(await to.get("themes/abc.css"))).toBe("changed");
  });

  test("a copy that does not read back the same counts as not copied", async () => {
    const broken: StorageAdapter = {
      ...to,
      get: async () => new Uint8Array([9]),
      exists: async () => false,
    };
    const result = await migrateFiles(from, broken);
    expect(result.copied).toBe(0);
    expect(result.failed.map((f) => f.reason)).toEqual(
      Array(3).fill("the copy does not match the original"),
    );
  });
});

const endpoint = process.env["S3_TEST_ENDPOINT"];
const service =
  endpoint && process.env["S3_TEST_ACCESS_KEY"] && process.env["S3_TEST_SECRET_KEY"]
    ? {
        endpoint,
        region: process.env["S3_TEST_REGION"] ?? "us-east-1",
        accessKeyId: process.env["S3_TEST_ACCESS_KEY"],
        secretAccessKey: process.env["S3_TEST_SECRET_KEY"],
      }
    : null;

describe.skipIf(!service)("moving files to a real S3 service and back", () => {
  test("folder to bucket (with a prefix) and back to a new folder; the bucket lists more than one page", async () => {
    const bucket = "oks-test-migrate";
    const client = s3Client({ ...service!, bucket });
    expect([200, 409]).toContain((await client.request("PUT", "")).status);
    // 1,050 small files: more than one page of the bucket list (1,000 keys).
    for (let i = 0; i < 1047; i++)
      await from.put(`2026/10/f${String(i).padStart(4, "0")}.txt`, new Uint8Array([i % 256]));
    await from.put("2026/11/a & b <c>.png", new Uint8Array(randomBytes(300)));
    const store = s3Adapter({ ...service!, bucket, prefix: "site-1" });
    try {
      expect(await migrateFiles(from, store)).toMatchObject({ copied: 1051, failed: [] });
      const keys = await all(store);
      expect(keys).toHaveLength(1051);
      expect(keys).toContain("2026/11/a & b <c>.png");
      const back = localAdapter({ root: path.join(dir, "back") });
      expect(await migrateFiles(store, back)).toMatchObject({ copied: 1051, failed: [] });
      expect(await all(back)).toEqual(await all(from));
      expect(
        Buffer.from(await back.get("2026/11/a & b <c>.png")).equals(
          Buffer.from(await from.get("2026/11/a & b <c>.png")),
        ),
      ).toBe(true);
    } finally {
      for await (const key of store.list()) await store.delete(key);
    }
  }, 120_000);
});
