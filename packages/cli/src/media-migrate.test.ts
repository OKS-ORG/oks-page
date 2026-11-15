// `oks media migrate`: what it says when something is missing, and a real run to a bucket when S3_TEST_* is set.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAdapter, s3Adapter, s3Client } from "@oks-page/media";
import { describe, expect, test } from "vitest";
import { runCli } from "./main.js";

const run = async (args: string[], env: Record<string, string | undefined>) => {
  const lines: string[] = [];
  const code = await runCli(args, (t) => lines.push(t), env);
  return { code, lines };
};

describe("oks media migrate", () => {
  test("needs --to s3 or --to local", async () => {
    const { code, lines } = await run(["media", "migrate"], {});
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("oks media migrate --to s3|local");
  });
  test("names the bucket settings that are missing", async () => {
    const { code, lines } = await run(["media", "migrate", "--to", "s3"], { OKS_S3_BUCKET: "b" });
    expect(code).toBe(1);
    expect(lines).toEqual([
      "Problem: S3 storage needs OKS_S3_ACCESS_KEY_ID, OKS_S3_SECRET_ACCESS_KEY.",
    ]);
  });

  const endpoint = process.env["S3_TEST_ENDPOINT"];
  test.skipIf(!endpoint || !process.env["S3_TEST_ACCESS_KEY"])(
    "copies the uploads folder to the bucket, then says how to switch; nothing is deleted",
    async () => {
      const bucket = "oks-test-cli";
      const env = {
        OKS_S3_ENDPOINT: endpoint,
        OKS_S3_REGION: process.env["S3_TEST_REGION"] ?? "us-east-1",
        OKS_S3_BUCKET: bucket,
        OKS_S3_ACCESS_KEY_ID: process.env["S3_TEST_ACCESS_KEY"],
        OKS_S3_SECRET_ACCESS_KEY: process.env["S3_TEST_SECRET_KEY"],
      };
      const options = {
        endpoint: endpoint!,
        region: env.OKS_S3_REGION,
        bucket,
        accessKeyId: env.OKS_S3_ACCESS_KEY_ID!,
        secretAccessKey: env.OKS_S3_SECRET_ACCESS_KEY!,
      };
      expect([200, 409]).toContain((await s3Client(options).request("PUT", "")).status);
      const folder = mkdtempSync(join(tmpdir(), "oks-cli-uploads-"));
      const local = localAdapter({ root: folder });
      await local.put("2026/11/a.jpg", new Uint8Array([1, 2, 3]));
      await local.put("2026/11/a-640.webp", new Uint8Array([4]));
      const store = s3Adapter(options);
      try {
        const first = await run(["media", "migrate", "--to", "s3", "--uploads", folder], env);
        expect(first.code).toBe(0);
        expect(first.lines.at(-1)).toBe(
          "2 copied and checked, 0 already there, 0 not copied. Nothing was deleted. Set OKS_STORAGE=s3 and restart the site to use the bucket.",
        );
        expect([...(await store.get("2026/11/a.jpg"))]).toEqual([1, 2, 3]);
        expect(await local.exists("2026/11/a.jpg")).toBe(true);
        const again = await run(["media", "migrate", "--to", "s3", "--uploads", folder], env);
        expect(again.lines.at(-1)).toMatch(
          /^0 copied and checked, 2 already there, 0 not copied\./,
        );
      } finally {
        for await (const key of store.list()) await store.delete(key);
      }
    },
    60_000,
  );
});
