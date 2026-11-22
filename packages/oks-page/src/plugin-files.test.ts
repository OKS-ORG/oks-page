// The files visitors send to a plugin (spec 16, section 6; FM-07): which files are taken (pictures and PDF, by their bytes),
// what is refused and why, how much may wait, how a file that was never attached goes, and who may open a kept file. In
// SQLite and PostgreSQL.
import type { Actor } from "@oks-page/core";
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeEach, describe, expect, test } from "vitest";
import {
  deleteItemFiles,
  openPluginFile,
  PENDING_BYTES_MOST,
  PENDING_KEEP_MS,
  purgePendingFiles,
  receiveFiles,
} from "./plugin-files";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000121";
const SITE2 = "SITE0000000000000000000122";
const EXT = "EXT00000000000000000000121";
const EXT2 = "EXT00000000000000000000122";
const LIMITS = { files: 3, maxFileBytes: 10 * 1024 * 1024 };
const MIN = 60_000;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
  Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0"),
  Buffer.alloc(20, 7),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypmp42"),
  Buffer.alloc(20),
]);
const part = (name: string, bytes: Uint8Array, field = "attachment") => ({ field, name, bytes });

const manager: Actor = { userId: "USER0000000000000000000121", can: () => true };
const reader: Actor = { userId: "USER0000000000000000000122", can: () => false };

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: files sent to a plugin`, () => {
    let db: TestDb;
    const count = async (status?: string) =>
      Number(
        (
          await db.runner.all(
            `select count(*) as "n" from extension_files${status ? ` where "status" = '${status}'` : ""}`,
          )
        )[0]!["n"],
      );

    beforeEach(async () => {
      db = await open();
      for (const id of [SITE, SITE2])
        await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
          id,
          T,
          T,
        ]);
      for (const [id, site, key] of [
        [EXT, SITE, "forms"],
        [EXT2, SITE2, "forms"],
      ] as const)
        await db.run(
          "insert into extensions (id, site_id, key, kind, version, tier, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?)",
          [id, site, key, T],
        );
    });

    test("pictures and PDF files are taken, by their bytes, with a clean name and the type that was read", async () => {
      const r = await receiveFiles(db.runner, EXT, LIMITS, [
        part("My Holiday Photo.PNG", PNG),
        part("Offer 2026.pdf", PDF),
        part("scan.jpeg", JPEG),
      ]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.files.map((f) => [f.name, f.type, f.size, f.field])).toEqual([
        ["My-Holiday-Photo.png", "image/png", PNG.length, "attachment"],
        ["Offer-2026.pdf", "application/pdf", PDF.length, "attachment"],
        ["scan.jpg", "image/jpeg", JPEG.length, "attachment"],
      ]);
      expect(await count("pending")).toBe(3);
      // The bytes are kept exactly.
      const row = (
        await db.runner.all(`select "data", "sha256" from extension_files where "id" = ?`, [
          r.files[0]!.id,
        ])
      )[0]!;
      expect(Buffer.from(row["data"] as Uint8Array).equals(PNG)).toBe(true);
      expect(String(row["sha256"])).toMatch(/^[0-9a-f]{64}$/);
    });

    test.each([
      ["an empty file", part("a.png", Buffer.alloc(0)), "The file is empty."],
      [
        "a web page named as a picture",
        part("x.jpg", Buffer.from("<html><script>alert(1)</script></html>")),
        "This kind of file is not allowed.",
      ],
      [
        "a PNG named as a JPEG",
        part("x.jpg", PNG),
        "The file says it is .jpg but its content is image/png.",
      ],
      [
        "a script",
        part("run.png", Buffer.from("#!/bin/sh\nrm -rf /\n")),
        "This kind of file is not allowed.",
      ],
      ["an SVG picture", part("logo.svg", SVG), "You are not allowed to upload SVG files."],
      ["a video", part("clip.mp4", MP4), "Only pictures and PDF files can be sent."],
    ])("%s is refused in plain words, and nothing is kept", async (_name, file, words) => {
      const r = await receiveFiles(db.runner, EXT, LIMITS, [part("ok.png", PNG), file]);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message).toContain(words);
      expect(await count()).toBe(0);
    });

    test("a file over the size, and more files than the route allows, are refused", async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(200)]);
      const tooBig = await receiveFiles(db.runner, EXT, { files: 3, maxFileBytes: 100 }, [
        part("big.png", big),
      ]);
      expect(!tooBig.ok && tooBig.message).toContain("The file is too big");
      const tooMany = await receiveFiles(db.runner, EXT, { files: 2, maxFileBytes: 1000 }, [
        part("a.png", PNG),
        part("b.png", PNG),
        part("c.png", PNG),
      ]);
      expect(!tooMany.ok && tooMany.message).toBe("At most 2 files can be sent at once.");
      expect(await count()).toBe(0);
    });

    test("a name with folders or control characters is shown cleanly in a message about it", async () => {
      const r = await receiveFiles(db.runner, EXT, LIMITS, [
        part("C:\\Users\\x\\evil\u0007.exe", Buffer.from("MZ")),
      ]);
      expect(!r.ok && r.message.startsWith("evil.exe: ")).toBe(true);
    });

    test("only so much may wait to be attached, so a program cannot fill the database", async () => {
      await db.run(
        `insert into extension_files (id, extension_id, name, mime, size_bytes, sha256, status, data, created_at) values (?, ?, 'a.png', 'image/png', ?, 'x', 'pending', ?, ?)`,
        [`FILE${"1".padStart(22, "0")}`, EXT, PENDING_BYTES_MOST - 10, Buffer.from([1]), T],
      );
      const r = await receiveFiles(db.runner, EXT, LIMITS, [part("a.png", PNG)], () => T.getTime());
      expect(!r.ok && r.message).toContain("Too many files are being sent right now");
      // Another plugin has its own room.
      const other = await receiveFiles(db.runner, EXT2, LIMITS, [part("a.png", PNG)]);
      expect(other.ok).toBe(true);
    });

    test("a file that was never attached goes after an hour; a kept file stays", async () => {
      const now = 1_800_000_000_000;
      const add = (n: number, status: string, at: number) =>
        db.run(
          `insert into extension_files (id, extension_id, name, mime, size_bytes, sha256, status, collection, key, data, created_at) values (?, ?, 'a.png', 'image/png', 1, 'x', ?, ?, ?, ?, ?)`,
          [
            `FILE${String(n).padStart(22, "0")}`,
            EXT,
            status,
            status === "kept" ? "c" : null,
            status === "kept" ? "k" : null,
            Buffer.from([1]),
            new Date(at),
          ],
        );
      await add(1, "pending", now - PENDING_KEEP_MS - MIN);
      await add(2, "pending", now - 10 * MIN);
      await add(3, "kept", now - 30 * 24 * 60 * MIN);
      expect(await purgePendingFiles(db.runner, () => now)).toBe(1);
      expect(await count()).toBe(2);
      expect(await count("kept")).toBe(1);
    });

    test("deleting an item deletes only the files kept with it", async () => {
      const add = (n: number, c: string, k: string) =>
        db.run(
          `insert into extension_files (id, extension_id, name, mime, size_bytes, sha256, status, collection, key, data, created_at) values (?, ?, 'a.png', 'image/png', 1, 'x', 'kept', ?, ?, ?, ?)`,
          [`FILE${String(n).padStart(22, "0")}`, EXT, c, k, Buffer.from([1]), T],
        );
      await add(1, "messages", "a");
      await add(2, "messages", "a");
      await add(3, "messages", "b");
      await deleteItemFiles(db.runner, EXT, "messages", "a");
      expect(await count()).toBe(1);
    });

    test("a kept file is opened only by a person who manages plugins, on its own site, byte for byte", async () => {
      const bytes = Buffer.from([0, 255, 128, 10, 13, 65, 0, 200]);
      const row = (n: number, ext: string, status: string) =>
        db.run(
          `insert into extension_files (id, extension_id, name, mime, size_bytes, sha256, status, collection, key, data, created_at) values (?, ?, 'report.pdf', 'application/pdf', 8, 'x', ?, 'c', 'k', ?, ?)`,
          [`FILE${String(n).padStart(22, "0")}`, ext, status, bytes, T],
        );
      await row(1, EXT, "kept");
      await row(2, EXT, "pending");
      await row(3, EXT2, "kept");
      const id = (n: number) => `FILE${String(n).padStart(22, "0")}`;
      const opened = await openPluginFile(db.runner, manager, SITE, id(1));
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(opened.bytes.equals(bytes)).toBe(true);
        expect([opened.name, opened.mime, opened.plugin]).toEqual([
          "report.pdf",
          "application/pdf",
          "forms",
        ]);
      }
      const nope = await openPluginFile(db.runner, reader, SITE, id(1));
      expect(!nope.ok && nope.code).toBe("forbidden");
      // Still waiting to be attached, another site's, and unknown: not found.
      for (const n of [2, 3, 9]) {
        const r = await openPluginFile(db.runner, manager, SITE, id(n));
        expect(!r.ok && r.code).toBe("not_found");
      }
    });
  });
}
