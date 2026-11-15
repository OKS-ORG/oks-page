// The S3 adapter. The signing is checked against the example in Amazon's documentation; the adapter itself runs the same
// tests as the local disk (MD-33) against a real S3-compatible service when S3_TEST_ENDPOINT, S3_TEST_ACCESS_KEY and
// S3_TEST_SECRET_KEY are set (locally: SeaweedFS), and is skipped otherwise.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  s3Adapter,
  s3Client,
  s3OptionsFromEnv,
  signS3Request,
  type S3AdapterOptions,
} from "./storage-s3.js";
import type { StorageAdapter } from "./storage.js";

describe("signing (AWS Signature Version 4)", () => {
  test("gives the signature of Amazon's documented example (GET Object with a range)", () => {
    const headers = signS3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      date: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
    });
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  });
});

describe("addresses", () => {
  const seen: string[] = [];
  const fake = (async (url: URL | string) => {
    seen.push(String(url));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const base = {
    bucket: "photos",
    region: "eu-central-1",
    accessKeyId: "a",
    secretAccessKey: "s",
    fetch: fake,
  };

  test("Amazon: the bucket in the host name; another service: the bucket in the path; keys are encoded", async () => {
    seen.length = 0;
    await s3Client(base).request("GET", "2026/11/abc-my photo é.png");
    await s3Client({
      ...base,
      endpoint: "https://acc.r2.cloudflarestorage.com",
      region: "auto",
    }).request("GET", "2026/11/a(1).png");
    await s3Client({ ...base, endpoint: "https://s3.example.com", pathStyle: false }).request(
      "HEAD",
      "x.png",
    );
    expect(seen).toEqual([
      "https://photos.s3.eu-central-1.amazonaws.com/2026/11/abc-my%20photo%20%C3%A9.png",
      "https://acc.r2.cloudflarestorage.com/photos/2026/11/a%281%29.png",
      "https://photos.s3.example.com/x.png",
    ]);
  });

  test("a prefix puts every key in a folder; files are served by the site unless a public address is set", async () => {
    seen.length = 0;
    const store = s3Adapter({ ...base, prefix: "/my-site/" });
    await store.put("2026/11/a.png", new Uint8Array([1]));
    expect(seen).toEqual(["https://photos.s3.eu-central-1.amazonaws.com/my-site/2026/11/a.png"]);
    expect(store.publicUrl("2026/11/a b.png")).toBe("/uploads/2026/11/a%20b.png");
    expect(s3Adapter({ ...base, baseUrl: "https://cdn.example.com/" }).publicUrl("a.png")).toBe(
      "https://cdn.example.com/a.png",
    );
    expect(() => s3Adapter({ ...base, prefix: "../up" })).toThrow(/not allowed/);
  });
});

describe("settings where the site runs", () => {
  const full = {
    OKS_STORAGE: "s3",
    OKS_S3_BUCKET: "photos",
    OKS_S3_ACCESS_KEY_ID: "key",
    OKS_S3_SECRET_ACCESS_KEY: "secret",
  };
  test("local disk unless OKS_STORAGE is s3", () => {
    expect(s3OptionsFromEnv({})).toBeNull();
    expect(s3OptionsFromEnv({ OKS_STORAGE: "local" })).toBeNull();
    expect(() => s3OptionsFromEnv({ OKS_STORAGE: "ftp" })).toThrow(/must be "local" or "s3"/);
  });
  test("S3: what is missing is named; odd values are refused; the defaults", () => {
    expect(() => s3OptionsFromEnv({ OKS_STORAGE: "s3", OKS_S3_BUCKET: "b" })).toThrow(
      "S3 storage needs OKS_S3_ACCESS_KEY_ID, OKS_S3_SECRET_ACCESS_KEY.",
    );
    expect(() => s3OptionsFromEnv({ ...full, OKS_S3_ENDPOINT: "not an address" })).toThrow(
      /OKS_S3_ENDPOINT/,
    );
    expect(() => s3OptionsFromEnv({ ...full, OKS_S3_ENDPOINT: "ftp://x" })).toThrow(/https/);
    expect(() => s3OptionsFromEnv({ ...full, OKS_S3_PATH_STYLE: "yes" })).toThrow(
      /OKS_S3_PATH_STYLE/,
    );
    expect(s3OptionsFromEnv(full)).toEqual({
      bucket: "photos",
      region: "us-east-1",
      accessKeyId: "key",
      secretAccessKey: "secret",
    });
    expect(
      s3OptionsFromEnv({
        ...full,
        OKS_S3_REGION: "auto",
        OKS_S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
        OKS_S3_PATH_STYLE: "true",
        OKS_S3_PREFIX: "site/",
      }),
    ).toMatchObject({
      region: "auto",
      endpoint: "https://acc.r2.cloudflarestorage.com",
      pathStyle: true,
      prefix: "site/",
    });
  });
});

const endpoint = process.env["S3_TEST_ENDPOINT"];
const service: Omit<S3AdapterOptions, "bucket"> | null =
  endpoint && process.env["S3_TEST_ACCESS_KEY"] && process.env["S3_TEST_SECRET_KEY"]
    ? {
        endpoint,
        region: process.env["S3_TEST_REGION"] ?? "us-east-1",
        accessKeyId: process.env["S3_TEST_ACCESS_KEY"],
        secretAccessKey: process.env["S3_TEST_SECRET_KEY"],
      }
    : null;

describe.skipIf(!service)(
  "the S3 adapter on a real service (MD-33: the same tests as the local disk)",
  () => {
    const bucket = "oks-test-adapter";
    let store: StorageAdapter;

    beforeAll(async () => {
      const made = await s3Client({ ...service!, bucket }).request("PUT", "");
      expect([200, 409]).toContain(made.status);
      store = s3Adapter({ ...service!, bucket, prefix: "site-1" });
    });
    afterAll(async () => {
      if (!service) return;
      const client = s3Client({ ...service, bucket });
      for (const key of [
        "site-1/2026/11/abc-a.png",
        "site-1/2026/11/abc-my photo é (1).png",
        "site-1/2026/11/big.bin",
      ])
        await client.request("DELETE", key);
    });

    test("store then read gives the same bytes", async () => {
      const data = new Uint8Array([1, 2, 3, 250, 0, 7]);
      await store.put("2026/11/abc-a.png", data);
      expect(await store.exists("2026/11/abc-a.png")).toBe(true);
      expect([...(await store.get("2026/11/abc-a.png"))]).toEqual([...data]);
    });

    test("a name with spaces, accents and brackets keeps its bytes", async () => {
      const data = new Uint8Array(randomBytes(1000));
      await store.put("2026/11/abc-my photo é (1).png", data);
      expect(
        Buffer.from(await store.get("2026/11/abc-my photo é (1).png")).equals(Buffer.from(data)),
      ).toBe(true);
    });

    test("a bigger file (5 MB) keeps its bytes", async () => {
      const data = new Uint8Array(randomBytes(5 * 1024 * 1024));
      await store.put("2026/11/big.bin", data);
      expect(Buffer.from(await store.get("2026/11/big.bin")).equals(Buffer.from(data))).toBe(true);
    });

    test("a missing file does not exist and cannot be read", async () => {
      expect(await store.exists("2026/11/none.png")).toBe(false);
      await expect(store.get("2026/11/none.png")).rejects.toThrow(/could not be read/);
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

    test("a wrong secret is refused in plain words, without the keys", async () => {
      const wrong = s3Adapter({ ...service!, bucket, secretAccessKey: "not-the-secret-123" });
      const error = (await wrong.get("2026/11/abc-a.png").catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(
        /^The file could not be read: the storage refused the access key/,
      );
      expect(error.message).not.toContain("not-the-secret-123");
      expect(error.message).not.toContain(service!.accessKeyId);
    });

    test("a bucket that does not exist says so (asked for a file: nothing is created)", async () => {
      // Writing is not used here: some services (SeaweedFS) make a missing bucket on a write, which then stays behind.
      const none = s3Adapter({ ...service!, bucket: `${bucket}-none` });
      const error = (await none.get("a.png").catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(
        /^The file could not be read: (the bucket does not exist|the storage answered 404)/,
      );
      expect(await none.exists("a.png")).toBe(false);
    });
  },
);
