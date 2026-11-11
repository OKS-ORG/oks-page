import { mkdtemp, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildKey, localAdapter, type StorageAdapter } from "./storage.js";

let dir: string;
let outside: string;
let store: StorageAdapter;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "oks-media-"));
  outside = await mkdtemp(path.join(tmpdir(), "oks-outside-"));
  store = localAdapter({ root: path.join(dir, "uploads"), baseUrl: "/uploads" });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("the local disk adapter (MD-16 to MD-19)", () => {
  test("store then read gives the same bytes", async () => {
    const data = new Uint8Array([1, 2, 3, 250, 0, 7]);
    await store.put("2026/11/abc-a.png", data);
    expect(await store.exists("2026/11/abc-a.png")).toBe(true);
    expect([...(await store.get("2026/11/abc-a.png"))]).toEqual([...data]);
  });

  test("a missing file does not exist and cannot be read", async () => {
    expect(await store.exists("2026/11/none.png")).toBe(false);
    await expect(store.get("2026/11/none.png")).rejects.toThrow();
  });

  test("delete removes it, and deleting twice is fine", async () => {
    await store.put("2026/11/x.png", new Uint8Array([1]));
    await store.delete("2026/11/x.png");
    expect(await store.exists("2026/11/x.png")).toBe(false);
    await store.delete("2026/11/x.png");
  });

  test.each([
    ["dots", "../secret.txt"],
    ["dots inside", "2026/../../secret.txt"],
    ["absolute", "/etc/passwd"],
    ["backslash", "2026\\11\\a.png"],
    ["drive letter", "C:/a.png"],
    ["null byte", "2026/a\0.png"],
    ["empty", ""],
    ["empty part", "2026//a.png"],
  ])("a bad key is refused: %s", async (_n, key) => {
    await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow(/not allowed/);
    await expect(store.get(key)).rejects.toThrow(/not allowed/);
    expect(await store.exists(key)).toBe(false);
    expect(() => store.publicUrl(key)).toThrow(/not allowed/);
  });

  test("a link inside the folder that leads outside cannot be read", async () => {
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    await mkdir(path.join(dir, "uploads"), { recursive: true });
    await symlink(outside, path.join(dir, "uploads", "link"));
    await expect(store.get("link/secret.txt")).rejects.toThrow(/not allowed/);
    expect(await store.exists("link/secret.txt")).toBe(false);
  });

  test("no temporary file stays after a write", async () => {
    await store.put("2026/11/y.png", new Uint8Array([1, 2]));
    expect(await readdir(path.join(dir, "uploads", "2026", "11"))).toEqual(["y.png"]);
  });

  test("a failed write leaves no half-written file", async () => {
    // A file where the folder should be makes the write fail.
    await mkdir(path.join(dir, "uploads"), { recursive: true });
    await writeFile(path.join(dir, "uploads", "2026"), "not a folder");
    await expect(store.put("2026/11/z.png", new Uint8Array([1]))).rejects.toThrow();
    expect(await readdir(path.join(dir, "uploads"))).toEqual(["2026"]);
  });

  test("the public address encodes the key", () => {
    expect(store.publicUrl("2026/11/abc-my photo é.png")).toBe(
      "/uploads/2026/11/abc-my%20photo%20%C3%A9.png",
    );
  });
});

describe("keys", () => {
  test("look like year/month/id-name", () => {
    expect(buildKey("01ABC", "a.png", new Date(Date.UTC(2026, 9, 3)))).toBe("2026/10/01ABC-a.png");
  });
});
