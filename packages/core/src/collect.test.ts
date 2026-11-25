// Client content collection (spec 11, section 8; AG-60 to AG-66, AG-88), on SQLite and PostgreSQL: the link and its limits,
// what a wrong, turned-off or expired link says, that text is kept as plain text and files wait out of the library until a
// person accepts them, and that nothing is published by itself.
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { localAdapter, type StorageAdapter } from "@oks-page/media";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  acceptCollected,
  createCollectLink,
  discardCollected,
  listCollectLinks,
  listInbox,
  openCollectLink,
  plainText,
  setCollectLinkOn,
  submitCollected,
} from "./collect.js";
import type { Actor } from "./content.js";
import { drainJobs } from "./jobs.js";
import { MEDIA_JOB, mediaJobHandler, type MediaContext } from "./media.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const DAY = 24 * 60 * 60 * 1000;
const can = (role: string): Actor["can"] => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return (c) => caps.includes(c);
};
const jpeg = async (w = 400, h = 200) =>
  new Uint8Array(
    await sharp({
      create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .jpeg()
      .toBuffer(),
  );
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>',
);
const PHP = new TextEncoder().encode("<?php system($_GET['c']); ?>");

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: client content collection`, () => {
    let db: TestDb;
    let dir: string;
    let storage: StorageAdapter;
    let ctx: MediaContext;
    let siteId = "";
    let anna: Actor;
    let editor: Actor;
    let clock = T.getTime();
    const now = () => clock;

    const files = async () => {
      const out: string[] = [];
      const walk = async (d: string) => {
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (e.isDirectory()) await walk(path.join(d, e.name));
          else out.push(e.name);
        }
      };
      await walk(dir);
      return out;
    };
    const count = async (table: string, where = "1 = 1") =>
      Number((await db.run(`select count(*) as n from ${table} where ${where}`))[0]!["n"]);
    const link = async (input: Record<string, unknown> = {}) => {
      const r = await createCollectLink(
        db.runner,
        anna,
        siteId,
        { label: "Photos for About", ...input },
        now,
      );
      if (!r.ok) throw new Error(r.message);
      return r;
    };

    beforeEach(async () => {
      db = await open();
      dir = await mkdtemp(path.join(tmpdir(), "oks-collect-"));
      storage = localAdapter({ root: dir, baseUrl: "/uploads" });
      ctx = { storage };
      clock = T.getTime();
      const setup = await runSetup(
        db.runner,
        async (input) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, input.name, input.email, T, T],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@garden.test", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      anna = { userId: setup.userId, can: can("administrator") };
      editor = { userId: setup.userId, can: can("editor") };
    });
    afterEach(async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    describe("the link (AG-60)", () => {
      test("a link is a 256-bit random token, shown once, of which only the hash is kept", async () => {
        const r = await link();
        expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const rows = await db.run(`select * from collect_links`);
        expect(rows).toHaveLength(1);
        expect(rows[0]!["token_hash"]).toBe(createHash("sha256").update(r.token).digest("hex"));
        expect(JSON.stringify(rows[0])).not.toContain(r.token);
        const other = await link({ label: "Another" });
        expect(other.token).not.toBe(r.token);
      });

      test("the defaults are 14 days, 10 files, 50 MB and 20,000 characters", async () => {
        const r = await link();
        expect(r.expiresAt).toBe(T.getTime() + 14 * DAY);
        const [view] = await listCollectLinks(db.runner, anna, siteId, now);
        expect(view).toMatchObject({
          label: "Photos for About",
          state: "working",
          maxFiles: 10,
          maxBytes: 50 * 1024 * 1024,
          maxText: 20_000,
          usedFiles: 0,
          waiting: 0,
        });
      });

      test("limits outside what is allowed are refused in words, and only people who manage the site may make links", async () => {
        for (const [input, words] of [
          [{ label: "" }, /Say what it is for/],
          [{ label: "x".repeat(81) }, /at most 80/],
          [{ days: 0 }, /1 to 90 days/],
          [{ days: 91 }, /1 to 90 days/],
          [{ maxFiles: 11 }, /0 to 10/],
          [{ maxMegabytes: 51 }, /1 to 50 MB/],
          [{ maxText: 20_001 }, /0 to 20000/],
          [{ days: "soon" }, /1 to 90 days/],
        ] as const) {
          const r = await createCollectLink(db.runner, anna, siteId, { label: "L", ...input }, now);
          expect(r, JSON.stringify(input)).toMatchObject({
            ok: false,
            code: "invalid",
            message: expect.stringMatching(words),
          });
        }
        expect(
          await createCollectLink(db.runner, editor, siteId, { label: "L" }, now),
        ).toMatchObject({ ok: false, code: "forbidden" });
        expect(await count("collect_links")).toBe(0);
        expect(await listCollectLinks(db.runner, editor, siteId, now)).toEqual([]);
      });
    });

    describe("a link that does not work (AG-61)", () => {
      test("a wrong token, a turned-off link and an expired link each get their plain message", async () => {
        const r = await link();
        expect(await openCollectLink(db.runner, "nonsense", now)).toMatchObject({
          ok: false,
          message: "This link does not work.",
        });
        expect(await openCollectLink(db.runner, "x".repeat(43), now)).toMatchObject({
          ok: false,
          reason: "unknown",
        });
        expect(await openCollectLink(db.runner, undefined, now)).toMatchObject({
          ok: false,
          reason: "unknown",
        });
        expect((await openCollectLink(db.runner, r.token, now)).ok).toBe(true);

        await setCollectLinkOn(db.runner, anna, siteId, r.id, false, now);
        expect(await openCollectLink(db.runner, r.token, now)).toMatchObject({
          ok: false,
          reason: "off",
          message: expect.stringMatching(/turned off/),
        });
        expect(await submitCollected(db.runner, r.token, { text: "hello" }, now)).toMatchObject({
          ok: false,
          code: "closed",
        });
        await setCollectLinkOn(db.runner, anna, siteId, r.id, true, now);
        expect((await submitCollected(db.runner, r.token, { text: "hello" }, now)).ok).toBe(true);

        clock = T.getTime() + 14 * DAY + 1;
        expect(await openCollectLink(db.runner, r.token, now)).toMatchObject({
          ok: false,
          reason: "expired",
          message: expect.stringMatching(/has expired/),
        });
        expect(await submitCollected(db.runner, r.token, { text: "more" }, now)).toMatchObject({
          ok: false,
          code: "closed",
        });
        expect((await listCollectLinks(db.runner, anna, siteId, now))[0]!.state).toBe("expired");
        expect(await count("collect_items")).toBe(1);
      });
    });

    describe("what a client sends (AG-62, AG-63)", () => {
      test("text is kept as plain text, with its tags removed", async () => {
        const r = await link();
        const sent = await submitCollected(
          db.runner,
          r.token,
          {
            sender: "<b>Chloé</b>",
            text: "<p>Hello <b>world</b></p><script>alert(1)</script>\r\n\r\nSecond <img src=x onerror=alert(1)> part\u0000",
          },
          now,
        );
        expect(sent).toMatchObject({ ok: true, texts: 1, files: 0 });
        const [item] = await listInbox(db.runner, anna, siteId);
        expect(item).toMatchObject({ kind: "text", sender: "Chloé", status: "pending" });
        expect(item!.text).toBe("Hello worldalert(1)\n\nSecond  part");
        for (const bad of ["<", ">", "\u0000"]) expect(item!.text.includes(bad)).toBe(false);
        expect(plainText("a < b > c")).toBe("a  c");
      });

      test("a file passes the media checks, and waits in the inbox, not in the public library (AG-62)", async () => {
        const r = await link();
        const sent = await submitCollected(
          db.runner,
          r.token,
          { sender: "Chloé", files: [{ name: "Garden Photo.JPG", bytes: await jpeg() }] },
          now,
        );
        expect(sent).toMatchObject({ ok: true, files: 1 });
        const [item] = await listInbox(db.runner, anna, siteId);
        expect(item).toMatchObject({
          kind: "file",
          fileName: "Garden-Photo.jpg",
          mime: "image/jpeg",
          status: "pending",
        });
        // Out of the library and out of storage: nothing a visitor can ask for.
        expect(await count("media")).toBe(0);
        expect(await files()).toEqual([]);
        expect(await count("entries", "status = 'published'")).toBe(0);
      });

      test("a file that is not what it says, a script, a drawing with a script or an empty file is refused, and nothing of that submission stays", async () => {
        const r = await link();
        for (const [name, bytes] of [
          ["shell.php", PHP],
          ["photo.jpg", PHP],
          ["drawing.svg", SVG],
          ["empty.jpg", new Uint8Array()],
        ] as const) {
          const out = await submitCollected(
            db.runner,
            r.token,
            {
              text: "with a good text",
              files: [
                { name: "good.jpg", bytes: await jpeg() },
                { name, bytes },
              ],
            },
            now,
          );
          expect(out, name).toMatchObject({ ok: false, code: "invalid" });
        }
        expect(await count("collect_items")).toBe(0);
      });

      test("an empty submission is refused", async () => {
        const r = await link();
        expect(
          await submitCollected(db.runner, r.token, { sender: "Chloé", text: "   " }, now),
        ).toMatchObject({
          ok: false,
          message: expect.stringMatching(/Write some text or choose a file/),
        });
      });

      test("the limits hold across several submissions: files, bytes and text (AG-63)", async () => {
        const r = await link({ maxFiles: 2, maxMegabytes: 1, maxText: 100 });
        const one = await jpeg();
        expect(
          (
            await submitCollected(
              db.runner,
              r.token,
              { files: [{ name: "a.jpg", bytes: one }] },
              now,
            )
          ).ok,
        ).toBe(true);
        expect(
          (
            await submitCollected(
              db.runner,
              r.token,
              { files: [{ name: "b.jpg", bytes: one }] },
              now,
            )
          ).ok,
        ).toBe(true);
        expect(
          await submitCollected(
            db.runner,
            r.token,
            { files: [{ name: "c.jpg", bytes: one }] },
            now,
          ),
        ).toMatchObject({
          ok: false,
          message: expect.stringMatching(/Too many files.*takes 2 in all, and 0 can still be sent/),
        });
        expect((await submitCollected(db.runner, r.token, { text: "x".repeat(60) }, now)).ok).toBe(
          true,
        );
        expect(
          await submitCollected(db.runner, r.token, { text: "y".repeat(60) }, now),
        ).toMatchObject({
          ok: false,
          message: expect.stringMatching(/Too much text.*40 are left/),
        });
        const big = await link({ maxMegabytes: 1 });
        const huge = await jpeg(2400, 2400);
        const noise = new Uint8Array(1_100_000).map((_, i) => (i * 7919) % 251);
        const heavy = Buffer.concat([Buffer.from(huge), Buffer.from(noise)]);
        expect(heavy.length).toBeGreaterThan(1024 * 1024);
        expect(
          await submitCollected(
            db.runner,
            big.token,
            { files: [{ name: "big.jpg", bytes: new Uint8Array(heavy) }] },
            now,
          ),
        ).toMatchObject({ ok: false });
        const [view] = (await listCollectLinks(db.runner, anna, siteId, now)).filter(
          (l) => l.id === r.id,
        );
        expect(view).toMatchObject({ usedFiles: 2, usedText: 60, waiting: 3 });
      });

      test("what was accepted still counts against the limits", async () => {
        const r = await link({ maxFiles: 1 });
        await submitCollected(
          db.runner,
          r.token,
          { files: [{ name: "a.jpg", bytes: await jpeg() }] },
          now,
        );
        const [item] = await listInbox(db.runner, anna, siteId);
        expect((await acceptCollected(db.runner, ctx, anna, siteId, item!.id)).ok).toBe(true);
        expect(
          await submitCollected(
            db.runner,
            r.token,
            { files: [{ name: "b.jpg", bytes: await jpeg() }] },
            now,
          ),
        ).toMatchObject({ ok: false, message: expect.stringMatching(/Too many files/) });
      });
    });

    describe("the inbox (AG-64 to AG-66, AG-88)", () => {
      test("accepting a file puts it in the library through the normal upload, with its sizes, described with who sent it (AG-88)", async () => {
        const r = await link();
        await submitCollected(
          db.runner,
          r.token,
          { sender: "Chloé", files: [{ name: "a.jpg", bytes: await jpeg(800, 400) }] },
          now,
        );
        const [item] = await listInbox(db.runner, anna, siteId);
        const done = await acceptCollected(db.runner, ctx, anna, siteId, item!.id);
        expect(done).toMatchObject({ ok: true, kind: "file" });
        const media = (await db.run(`select * from media`))[0]!;
        expect(media).toMatchObject({
          mime_type: "image/jpeg",
          status: "processing",
          width: 800,
          height: 400,
        });
        expect(String(media["description"])).toBe("Sent by Chloé for: Photos for About");
        await drainJobs(db.runner, { [MEDIA_JOB]: mediaJobHandler(db.runner, ctx) });
        expect(await count("media_variants")).toBeGreaterThan(0);
        expect((await files()).length).toBeGreaterThan(1);
        // The inbox keeps the line but not the bytes.
        const row = (await db.run(`select status, data from collect_items`))[0]!;
        expect(row["status"]).toBe("accepted");
        expect(row["data"]).toBeNull();
        expect(await acceptCollected(db.runner, ctx, anna, siteId, item!.id)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/already/),
        });
      });

      test("accepting text makes a draft page, never a published one", async () => {
        const r = await link({ label: "About page" });
        await submitCollected(
          db.runner,
          r.token,
          { sender: "Chloé", text: "First paragraph.\n\nSecond paragraph." },
          now,
        );
        const [item] = await listInbox(db.runner, anna, siteId);
        const done = await acceptCollected(db.runner, ctx, anna, siteId, item!.id);
        expect(done).toMatchObject({ ok: true, kind: "text" });
        if (!done.ok || !done.entryId) throw new Error("no entry");
        const entry = (
          await db.run(`select title, status, plain_text, body from entries where id = ?`, [
            done.entryId,
          ])
        )[0]!;
        expect(entry["title"]).toBe("About page (from Chloé)");
        expect(entry["status"]).toBe("draft");
        const body = typeof entry["body"] === "string" ? JSON.parse(entry["body"]) : entry["body"];
        const blocks = (body.blocks ?? body) as { type: string; content: { text: string }[] }[];
        expect(blocks.map((b) => b.content[0]!.text)).toEqual([
          "First paragraph.",
          "Second paragraph.",
        ]);
        expect(await count("entries", "status = 'published' and title like 'About page%'")).toBe(0);
        const row = (await db.run(`select status, body from collect_items`))[0]!;
        expect(row).toMatchObject({ status: "accepted", body: "" });
      });

      test("an item can be thrown away, and only people who manage the site see or change the inbox", async () => {
        const r = await link();
        await submitCollected(db.runner, r.token, { text: "hello" }, now);
        const [item] = await listInbox(db.runner, anna, siteId);
        expect(await listInbox(db.runner, editor, siteId)).toEqual([]);
        expect(await acceptCollected(db.runner, ctx, editor, siteId, item!.id)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await discardCollected(db.runner, editor, siteId, item!.id)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await setCollectLinkOn(db.runner, editor, siteId, r.id, false, now)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await count("collect_items")).toBe(1);
        expect(await discardCollected(db.runner, anna, siteId, item!.id)).toEqual({ ok: true });
        expect(await count("collect_items")).toBe(0);
        expect(await discardCollected(db.runner, anna, siteId, item!.id)).toMatchObject({
          ok: false,
          code: "not_found",
        });
      });

      test("another site's items and links are out of reach", async () => {
        const r = await link();
        await submitCollected(db.runner, r.token, { text: "hello" }, now);
        const [item] = await listInbox(db.runner, anna, siteId);
        const other = newId();
        expect(await acceptCollected(db.runner, ctx, anna, other, item!.id)).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(await discardCollected(db.runner, anna, other, item!.id)).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(await setCollectLinkOn(db.runner, anna, other, r.id, false, now)).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(await listInbox(db.runner, anna, other)).toEqual([]);
        expect(await count("collect_items")).toBe(1);
      });

      test("nothing a client sends is published by itself (AG-66)", async () => {
        const r = await link();
        await submitCollected(
          db.runner,
          r.token,
          { sender: "Chloé", text: "hello", files: [{ name: "a.jpg", bytes: await jpeg() }] },
          now,
        );
        const before = await count("entries");
        expect(await count("entries", "title like '%Photos%'")).toBe(0);
        expect(await count("entries")).toBe(before);
        expect(await count("media")).toBe(0);
      });
    });
  });
}
