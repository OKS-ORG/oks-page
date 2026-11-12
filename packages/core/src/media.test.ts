// Media in the admin, on SQLite and PostgreSQL: upload, the job that makes the sizes, the library, edits, delete and
// finding a file to serve (spec 09: MD-01 to MD-09, MD-31, MD-32, MD-35, MD-36 at the logic level).
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { localAdapter, type StorageAdapter } from "@oks-page/media";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, saveContent, uploadKeysIn, type Actor } from "./content.js";
import { claimJob, drainJobs, enqueueJob, recoverStaleJobs, type JobHandler } from "./jobs.js";
import {
  deleteMedia,
  findFile,
  getMedia,
  listMedia,
  MEDIA_JOB,
  mediaJobHandler,
  replaceMedia,
  updateMedia,
  uploadMedia,
  type MediaContext,
} from "./media.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

const jpeg = (w = 800, h = 400) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg()
    .toBuffer();
const png = (w = 40, h = 40) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 0, b: 0 } } })
    .png()
    .toBuffer();
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" onclick="x()"/></svg>',
);
const PDF = new TextEncoder().encode("%PDF-1.7\n%test\n");

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: media in the admin`, () => {
    let db: TestDb;
    let dir: string;
    let storage: StorageAdapter;
    let ctx: MediaContext;
    let siteId = "";
    let anna: Actor; // administrator
    let eve: Actor; // editor
    let bob: Actor; // author
    let bea: Actor; // author
    let cara: Actor; // contributor
    let sam: Actor; // subscriber

    const user = async (name: string) => {
      const id = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [id, name, `${name.toLowerCase()}@example.com`, T, T],
      );
      return id;
    };
    const handlers = (): Record<string, JobHandler> => ({
      [MEDIA_JOB]: mediaJobHandler(db.runner, ctx),
    });
    const upload = async (actor: Actor, name: string, bytes: Uint8Array | Buffer) => {
      const r = await uploadMedia(db.runner, ctx, actor, siteId, {
        fileName: name,
        bytes: new Uint8Array(bytes),
      });
      if (!r.ok) throw new Error(r.message);
      return r;
    };
    const files = async () => {
      const out: string[] = [];
      const walk = async (d: string) => {
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (e.isDirectory()) await walk(path.join(d, e.name));
          else out.push(path.relative(dir, path.join(d, e.name)));
        }
      };
      await walk(dir);
      return out;
    };

    beforeEach(async () => {
      db = await open();
      dir = await mkdtemp(path.join(tmpdir(), "oks-media-core-"));
      storage = localAdapter({ root: dir, baseUrl: "/uploads" });
      ctx = { storage };
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const userId = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [userId, name, email, T, T],
          );
          return { userId };
        },
        {
          siteName: "S",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      anna = actorOf(setup.userId, "administrator");
      eve = actorOf(await user("Eve"), "editor");
      bob = actorOf(await user("Bob"), "author");
      bea = actorOf(await user("Bea"), "author");
      cara = actorOf(await user("Cara"), "contributor");
      sam = actorOf(await user("Sam"), "subscriber");
    });
    afterEach(async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    describe("upload", () => {
      test("an image is stored at once as processing, and a job makes the sizes (MD-31)", async () => {
        const r = await upload(bob, "My Photo.JPG", await jpeg());
        expect(r).toMatchObject({ status: "processing", fileName: "My-Photo.jpg" });
        expect(r.url).toMatch(/^\/uploads\/\d{4}\/\d{2}\/.+-My-Photo\.jpg$/);
        const row = (await db.run("select * from media where id = ?", [r.id]))[0]!;
        expect(row).toMatchObject({
          mime_type: "image/jpeg",
          status: "processing",
          width: 800,
          height: 400,
          alt: "",
        });
        expect(String(row["content_hash"])).toMatch(/^[0-9a-f]{64}$/);
        expect(await storage.exists(String(row["storage_key"]))).toBe(true);
        expect((await db.run("select status from jobs"))[0]!["status"]).toBe("queued");

        expect(await drainJobs(db.runner, handlers())).toEqual({ done: 1, failed: 0 });

        const after = (
          await db.run("select status, blur_placeholder from media where id = ?", [r.id])
        )[0]!;
        expect(after["status"]).toBe("ready");
        expect(String(after["blur_placeholder"])).toMatch(/^data:image\/webp;base64,/);
        const variants = await db.run(
          "select width, format, storage_key from media_variants where media_id = ? order by width, format",
          [r.id],
        );
        expect(variants.map((v) => `${v["width"]}.${v["format"]}`)).toEqual([
          "320.avif",
          "320.webp",
          "640.avif",
          "640.webp",
          "800.avif",
          "800.webp",
        ]);
        for (const v of variants) expect(await storage.exists(String(v["storage_key"]))).toBe(true);
        expect((await db.run("select status from jobs"))[0]!["status"]).toBe("done");
      });

      test("who may upload: administrators, editors and authors, not contributors or subscribers", async () => {
        for (const who of [anna, eve, bob])
          expect(
            (
              await uploadMedia(db.runner, ctx, who, siteId, {
                fileName: "a.png",
                bytes: new Uint8Array(await png()),
              })
            ).ok,
          ).toBe(true);
        for (const who of [cara, sam]) {
          const r = await uploadMedia(db.runner, ctx, who, siteId, {
            fileName: "a.png",
            bytes: new Uint8Array(await png()),
          });
          expect(r).toMatchObject({ ok: false, code: "forbidden" });
        }
      });

      test("a PDF is ready at once with no job", async () => {
        const r = await upload(bob, "Menu card.pdf", PDF);
        expect(r.status).toBe("ready");
        expect(Number((await db.run("select count(*) as n from jobs"))[0]!["n"])).toBe(0);
      });

      test("an SVG is cleaned before it is stored, only for people who may upload SVG (MD-36)", async () => {
        const refused = await uploadMedia(db.runner, ctx, bob, siteId, {
          fileName: "logo.svg",
          bytes: SVG,
        });
        expect(refused).toMatchObject({ ok: false, code: "forbidden" });
        const r = await upload(eve, "logo.svg", SVG);
        expect(r.status).toBe("ready");
        const key = String(
          (await db.run("select storage_key from media where id = ?", [r.id]))[0]!["storage_key"],
        );
        const stored = new TextDecoder().decode(await storage.get(key));
        expect(stored).toContain("<rect");
        expect(stored).not.toMatch(/script|onclick|alert/);
      });

      test("a refused file stores nothing: no row, no file, no job (MD-02 to MD-05)", async () => {
        const bad: [string, Uint8Array][] = [
          ["shell.php", new TextEncoder().encode("<?php echo 1; ?>")],
          ["photo.jpg", new Uint8Array(await png())],
          ["empty.png", new Uint8Array(0)],
          ["phone.heic", new TextEncoder().encode("\0\0\0\x18ftypheic" + "x".repeat(40))],
        ];
        for (const [name, bytes] of bad) {
          const r = await uploadMedia(db.runner, ctx, anna, siteId, { fileName: name, bytes });
          expect(r, name).toMatchObject({ ok: false, code: "invalid" });
        }
        expect(Number((await db.run("select count(*) as n from media"))[0]!["n"])).toBe(0);
        expect(Number((await db.run("select count(*) as n from jobs"))[0]!["n"])).toBe(0);
        expect(await files()).toEqual([]);
      });

      test("a file over the size limit and an image over the pixel limit are refused", async () => {
        const big = await uploadMedia(
          db.runner,
          { ...ctx, settings: { maxBytes: 100 } },
          anna,
          siteId,
          {
            fileName: "a.png",
            bytes: new Uint8Array(await png(200, 200)),
          },
        );
        expect(big).toMatchObject({
          ok: false,
          code: "invalid",
          message: expect.stringMatching(/too big/),
        });
        const px = await uploadMedia(
          db.runner,
          { ...ctx, settings: { maxPixels: 1000 } },
          anna,
          siteId,
          {
            fileName: "a.png",
            bytes: new Uint8Array(await png(200, 200)),
          },
        );
        expect(px).toMatchObject({
          ok: false,
          code: "invalid",
          message: expect.stringMatching(/too many pixels/),
        });
      });

      test("a folder must exist on this site", async () => {
        const r = await uploadMedia(db.runner, ctx, anna, siteId, {
          fileName: "a.png",
          bytes: new Uint8Array(await png()),
          folderId: newId(),
        });
        expect(r).toMatchObject({ ok: false, code: "invalid" });
        expect(await files()).toEqual([]);
      });
    });

    describe("the background job", () => {
      test("a damaged original fails at once, the file shows as failed, and the reason is kept (MD-31)", async () => {
        const r = await upload(bob, "a.jpg", await jpeg(300, 300));
        const key = String(
          (await db.run("select storage_key from media where id = ?", [r.id]))[0]!["storage_key"],
        );
        await writeFile(path.join(dir, key), "not an image at all");
        expect(await drainJobs(db.runner, handlers())).toEqual({ done: 0, failed: 1 });
        expect((await db.run("select status from media where id = ?", [r.id]))[0]!["status"]).toBe(
          "failed",
        );
        const job = (await db.run("select status, last_error, attempts from jobs"))[0]!;
        expect(job["status"]).toBe("failed");
        expect(job["attempts"]).toBe(1);
        expect(String(job["last_error"])).toMatch(/could not be read/);
      });

      test("a temporary failure is tried again later and then succeeds", async () => {
        const r = await upload(bob, "a.jpg", await jpeg(300, 300));
        let calls = 0;
        const flaky: StorageAdapter = {
          ...storage,
          get: async (key) => {
            if (++calls === 1) throw new Error("disk busy");
            return storage.get(key);
          },
        };
        const flakyHandlers = {
          [MEDIA_JOB]: mediaJobHandler(db.runner, { ...ctx, storage: flaky }),
        };
        expect(await drainJobs(db.runner, flakyHandlers)).toEqual({ done: 0, failed: 0 });
        const queued = (await db.run("select status, last_error, run_at from jobs"))[0]!;
        expect(queued["status"]).toBe("queued");
        expect(queued["last_error"]).toBe("disk busy");
        // Not due yet.
        expect(await drainJobs(db.runner, flakyHandlers)).toEqual({ done: 0, failed: 0 });
        // Later it is due.
        const later = () => Date.now() + 5 * 60_000;
        expect(await drainJobs(db.runner, flakyHandlers, { now: later })).toEqual({
          done: 1,
          failed: 0,
        });
        expect((await db.run("select status from media where id = ?", [r.id]))[0]!["status"]).toBe(
          "ready",
        );
      });

      test("a job that keeps failing ends failed after its tries (the file shows as failed)", async () => {
        const r = await upload(bob, "a.jpg", await jpeg(300, 300));
        const broken: StorageAdapter = {
          ...storage,
          get: async () => {
            throw new Error("gone");
          },
        };
        const h = { [MEDIA_JOB]: mediaJobHandler(db.runner, { ...ctx, storage: broken }) };
        let at = Date.now();
        for (let i = 0; i < 5; i++) {
          await drainJobs(db.runner, h, { now: () => at });
          at += 60 * 60_000;
        }
        expect((await db.run("select status, attempts from jobs"))[0]).toMatchObject({
          status: "failed",
          attempts: 5,
        });
        expect((await db.run("select status from media where id = ?", [r.id]))[0]!["status"]).toBe(
          "failed",
        );
      });

      test("at most 2 image jobs run at once (MD-32)", async () => {
        for (let i = 0; i < 6; i++) await upload(bob, `p${i}.jpg`, await jpeg(400, 300));
        let running = 0;
        let most = 0;
        const real = mediaJobHandler(db.runner, ctx);
        const counting: JobHandler = {
          run: async (job) => {
            running++;
            most = Math.max(most, running);
            try {
              await real.run(job);
            } finally {
              running--;
            }
          },
        };
        // Two calls at once still share the limit of the process.
        const results = await Promise.all([
          drainJobs(db.runner, { [MEDIA_JOB]: counting }),
          drainJobs(db.runner, { [MEDIA_JOB]: counting }),
        ]);
        expect(results.reduce((n, r) => n + r.done, 0)).toBe(6);
        expect(most).toBeLessThanOrEqual(2);
        expect(most).toBeGreaterThan(0);
        expect(
          Number((await db.run("select count(*) as n from media where status = 'ready'"))[0]!["n"]),
        ).toBe(6);
      });

      test("a file deleted while it waited is skipped", async () => {
        const r = await upload(anna, "a.jpg", await jpeg(300, 300));
        expect((await deleteMedia(db.runner, ctx, anna, siteId, r.id)).ok).toBe(true);
        expect(await drainJobs(db.runner, handlers())).toEqual({ done: 1, failed: 0 });
      });

      test("two workers never take the same job", async () => {
        await enqueueJob(db.runner, siteId, "x", { n: 1 });
        const [a, b] = await Promise.all([
          claimJob(db.runner, "w1", ["x"]),
          claimJob(db.runner, "w2", ["x"]),
        ]);
        expect([a, b].filter(Boolean)).toHaveLength(1);
      });

      test("a job left running by a stopped server is put back", async () => {
        await enqueueJob(db.runner, siteId, "x", {});
        const job = (await claimJob(db.runner, "w1", ["x"]))!;
        expect(await recoverStaleJobs(db.runner, 60_000)).toBe(0);
        expect(await recoverStaleJobs(db.runner, 60_000, () => Date.now() + 120_000)).toBe(1);
        expect((await db.run("select status from jobs where id = ?", [job.id]))[0]!["status"]).toBe(
          "queued",
        );
      });
    });

    describe("the library", () => {
      test("an author sees only their own files; editors and administrators see all", async () => {
        await upload(bob, "bob.png", await png());
        await upload(bea, "bea.png", await png());
        await upload(eve, "eve.pdf", PDF);
        const names = async (who: Actor) => {
          const r = await listMedia(db.runner, ctx, who, siteId);
          if (!r.ok) throw new Error(r.message);
          return r.items.map((i) => i.fileName).sort();
        };
        expect(await names(bob)).toEqual(["bob.png"]);
        expect(await names(eve)).toEqual(["bea.png", "bob.png", "eve.pdf"]);
        expect(await names(anna)).toEqual(["bea.png", "bob.png", "eve.pdf"]);
        expect(await listMedia(db.runner, ctx, sam, siteId)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
      });

      test("search, type and unused filters, order and paging", async () => {
        const a = await upload(anna, "Holiday Beach.png", await png());
        await upload(anna, "report.pdf", PDF);
        const c = await upload(anna, "100%_sure.png", await png());
        await updateMedia(db.runner, anna, siteId, a.id, {
          alt: "Waves on the sand",
          title: "Sea",
        });
        const names = async (o = {}) => {
          const r = await listMedia(db.runner, ctx, anna, siteId, o);
          if (!r.ok) throw new Error(r.message);
          return r.items.map((i) => i.fileName);
        };
        expect(await names({ search: "holiday" })).toEqual(["Holiday-Beach.png"]);
        expect(await names({ search: "waves" })).toEqual(["Holiday-Beach.png"]);
        expect(await names({ search: "100%" })).toEqual(["100%_sure.png"]); // % is not a wildcard
        expect(await names({ search: "_" })).toEqual(["100%_sure.png"]);
        expect(await names({ kind: "pdf" })).toEqual(["report.pdf"]);
        expect((await names({ kind: "image" })).sort()).toEqual([
          "100%_sure.png",
          "Holiday-Beach.png",
        ]);
        expect(await names({ kind: "video" })).toEqual([]);
        // Newest first.
        expect(await names()).toHaveLength(3);
        const first = await listMedia(db.runner, ctx, anna, siteId, { limit: 2 });
        expect(first).toMatchObject({ ok: true, total: 3 });
        expect(first.ok && first.items).toHaveLength(2);
        const rest = await listMedia(db.runner, ctx, anna, siteId, { limit: 2, offset: 2 });
        expect(rest.ok && rest.items.map((i) => i.id)).not.toContain(
          first.ok && first.items[0]!.id,
        );
        // Unused: a file a page uses is not listed.
        const page = await createDraft(db.runner, anna, siteId, { type: "page", title: "P" });
        if (!page.ok) throw new Error("draft");
        await db.run("insert into entry_media (entry_id, media_id, field) values (?, ?, ?)", [
          page.id,
          c.id,
          "body",
        ]);
        expect(await names({ unused: true })).not.toContain("100%_sure.png");
        expect(await names({ unused: true })).toHaveLength(2);
      });

      test("a file shows its sizes once they are ready, and the used-in list", async () => {
        const r = await upload(anna, "a.jpg", await jpeg(700, 300));
        await drainJobs(db.runner, handlers());
        const page = await createDraft(db.runner, anna, siteId, { type: "page", title: "Landing" });
        if (!page.ok) throw new Error("draft");
        await db.run("insert into entry_media (entry_id, media_id, field) values (?, ?, ?)", [
          page.id,
          r.id,
          "body",
        ]);
        const got = await getMedia(db.runner, ctx, anna, siteId, r.id);
        if (!got.ok) throw new Error(got.message);
        expect(got.item.status).toBe("ready");
        expect(got.item.variants.map((v) => `${v.width}.${v.format}`)).toContain("320.webp");
        expect(got.item.variants[0]!.url).toMatch(/^\/uploads\//);
        expect(got.usedIn).toEqual([{ id: page.id, title: "Landing", type: "page" }]);
        expect(got.canEdit).toBe(true);
      });

      test("another author's file does not exist for an author", async () => {
        const r = await upload(bea, "bea.png", await png());
        expect(await getMedia(db.runner, ctx, bob, siteId, r.id)).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(await getMedia(db.runner, ctx, eve, siteId, r.id)).toMatchObject({
          ok: true,
          canEdit: true,
        });
      });
    });

    describe("editing the description", () => {
      test("alt text, caption, title, description and focal point are saved", async () => {
        const r = await upload(bob, "a.png", await png());
        const done = await updateMedia(db.runner, bob, siteId, r.id, {
          alt: "A red square",
          caption: "Red",
          title: "Square",
          description: "A plain red square.",
          focalX: 0.25,
          focalY: 0.75,
        });
        expect(done.ok).toBe(true);
        expect(
          (
            await db.run(
              "select alt, caption, title, description, focal_x, focal_y from media where id = ?",
              [r.id],
            )
          )[0],
        ).toMatchObject({
          alt: "A red square",
          caption: "Red",
          title: "Square",
          description: "A plain red square.",
          focal_x: 0.25,
          focal_y: 0.75,
        });
        expect(
          (await updateMedia(db.runner, bob, siteId, r.id, { focalX: null, focalY: null })).ok,
        ).toBe(true);
      });

      test("a bad value is refused and nothing changes", async () => {
        const r = await upload(bob, "a.png", await png());
        expect(
          await updateMedia(db.runner, bob, siteId, r.id, { alt: "x".repeat(501) }),
        ).toMatchObject({ ok: false, code: "invalid" });
        expect(
          await updateMedia(db.runner, bob, siteId, r.id, { focalX: 2, focalY: 0.5 }),
        ).toMatchObject({ ok: false, code: "invalid" });
        expect(await updateMedia(db.runner, bob, siteId, r.id, { focalX: 0.5 })).toMatchObject({
          ok: false,
          code: "invalid",
        });
        expect(
          await updateMedia(db.runner, bob, siteId, r.id, { alt: 5 as unknown as string }),
        ).toMatchObject({ ok: false, code: "invalid" });
        expect((await db.run("select alt from media where id = ?", [r.id]))[0]!["alt"]).toBe("");
      });

      test("an author edits their own files only; an editor edits any", async () => {
        const r = await upload(bea, "bea.png", await png());
        expect(await updateMedia(db.runner, bob, siteId, r.id, { alt: "mine now" })).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect((await updateMedia(db.runner, eve, siteId, r.id, { alt: "by the editor" })).ok).toBe(
          true,
        );
        expect(await updateMedia(db.runner, sam, siteId, r.id, { alt: "x" })).toMatchObject({
          ok: false,
        });
      });

      test("it tells which pages use the file, so their cache can be refreshed", async () => {
        const r = await upload(anna, "a.png", await png());
        const page = await createDraft(db.runner, anna, siteId, { type: "page", title: "P" });
        if (!page.ok) throw new Error("draft");
        await db.run("insert into entry_media (entry_id, media_id, field) values (?, ?, ?)", [
          page.id,
          r.id,
          "body",
        ]);
        expect(await updateMedia(db.runner, anna, siteId, r.id, { alt: "x" })).toEqual({
          ok: true,
          usedIn: [page.id],
        });
      });
    });

    describe("deleting", () => {
      test("a file in use is refused and the pages are listed; after removing it from them it can go (MD-35)", async () => {
        const r = await upload(anna, "a.jpg", await jpeg(700, 300));
        await drainJobs(db.runner, handlers());
        const page = await createDraft(db.runner, anna, siteId, {
          type: "page",
          title: "About us",
        });
        if (!page.ok) throw new Error("draft");
        await db.run("insert into entry_media (entry_id, media_id, field) values (?, ?, ?)", [
          page.id,
          r.id,
          "body",
        ]);
        const before = await files();
        const refused = await deleteMedia(db.runner, ctx, anna, siteId, r.id);
        expect(refused).toMatchObject({
          ok: false,
          code: "in_use",
          usedIn: [{ id: page.id, title: "About us" }],
        });
        expect(await files()).toEqual(before);
        expect(Number((await db.run("select count(*) as n from media"))[0]!["n"])).toBe(1);

        await db.run("delete from entry_media where media_id = ?", [r.id]);
        expect((await deleteMedia(db.runner, ctx, anna, siteId, r.id)).ok).toBe(true);
        expect(await files()).toEqual([]);
        expect(Number((await db.run("select count(*) as n from media"))[0]!["n"])).toBe(0);
        expect(Number((await db.run("select count(*) as n from media_variants"))[0]!["n"])).toBe(0);
      });

      test("a page in the trash does not block the delete", async () => {
        const r = await upload(anna, "a.png", await png());
        const page = await createDraft(db.runner, anna, siteId, { type: "page", title: "Old" });
        if (!page.ok) throw new Error("draft");
        await db.run("insert into entry_media (entry_id, media_id, field) values (?, ?, ?)", [
          page.id,
          r.id,
          "body",
        ]);
        await db.run("update entries set status = 'trash' where id = ?", [page.id]);
        expect((await deleteMedia(db.runner, ctx, anna, siteId, r.id)).ok).toBe(true);
      });

      test("only people with the delete capability may delete (editors and administrators)", async () => {
        const mine = await upload(bob, "bob.png", await png());
        expect(await deleteMedia(db.runner, ctx, bob, siteId, mine.id)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await deleteMedia(db.runner, ctx, bea, siteId, mine.id)).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect((await deleteMedia(db.runner, ctx, eve, siteId, mine.id)).ok).toBe(true);
        expect(await deleteMedia(db.runner, ctx, eve, siteId, newId())).toMatchObject({
          ok: false,
          code: "not_found",
        });
      });
    });

    describe("replacing a file", () => {
      const replace = (actor: Actor, id: string, name: string, bytes: Uint8Array | Buffer) =>
        replaceMedia(db.runner, ctx, actor, siteId, id, {
          fileName: name,
          bytes: new Uint8Array(bytes),
        });

      test("the address, descriptions and pages stay; the file and its sizes are new", async () => {
        const r = await upload(anna, "photo.jpg", await jpeg(800, 400));
        await drainJobs(db.runner, handlers());
        await updateMedia(db.runner, anna, siteId, r.id, { alt: "A lake", title: "Lake" });
        const page = await createDraft(db.runner, anna, siteId, { type: "page", title: "Trip" });
        if (!page.ok) throw new Error("draft");
        await db.run("insert into entry_media (entry_id, media_id, field) values (?, ?, ?)", [
          page.id,
          r.id,
          "body",
        ]);
        const before = (await db.run("select * from media where id = ?", [r.id]))[0]!;

        const done = await replace(anna, r.id, "new-name.jpg", await jpeg(300, 300));
        expect(done).toMatchObject({ ok: true, status: "processing", usedIn: [page.id] });

        const row = (await db.run("select * from media where id = ?", [r.id]))[0]!;
        expect(row).toMatchObject({
          storage_key: before["storage_key"],
          filename: "photo.jpg",
          alt: "A lake",
          title: "Lake",
          width: 300,
          height: 300,
          status: "processing",
          blur_placeholder: null,
        });
        expect(row["content_hash"]).not.toBe(before["content_hash"]);
        expect(Number((await db.run("select count(*) as n from media_variants"))[0]!["n"])).toBe(0);
        const meta = await sharp(
          Buffer.from(await storage.get(String(row["storage_key"]))),
        ).metadata();
        expect(meta.width).toBe(300);

        expect(await drainJobs(db.runner, handlers())).toEqual({ done: 1, failed: 0 });
        const widths = (
          await db.run("select width from media_variants where media_id = ?", [r.id])
        ).map((v) => Number(v["width"]));
        expect(Math.max(...widths)).toBe(300);
        const keys = await files();
        expect(keys.filter((k) => k.includes("-800."))).toEqual([]);
      });

      test("a different kind of file is refused and nothing changes", async () => {
        const r = await upload(anna, "photo.jpg", await jpeg());
        const before = await files();
        expect(await replace(anna, r.id, "photo.png", await png())).toMatchObject({
          ok: false,
          code: "invalid",
        });
        expect(await replace(anna, r.id, "x.pdf", PDF)).toMatchObject({
          ok: false,
          code: "invalid",
        });
        expect(await files()).toEqual(before);
      });

      test("a file that fails the checks leaves the old one in place", async () => {
        const r = await upload(anna, "photo.jpg", await jpeg());
        const key = String((await db.run("select storage_key from media"))[0]!["storage_key"]);
        const old = Buffer.from(await storage.get(key));
        expect(
          await replace(anna, r.id, "photo.jpg", new TextEncoder().encode("not a picture")),
        ).toMatchObject({ ok: false, code: "invalid" });
        expect(Buffer.from(await storage.get(key)).equals(old)).toBe(true);
      });

      test("only people who may edit the file can replace it", async () => {
        const mine = await upload(bob, "bob.jpg", await jpeg());
        expect(await replace(bea, mine.id, "bob.jpg", await jpeg())).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(await replace(sam, mine.id, "bob.jpg", await jpeg())).toMatchObject({
          ok: false,
        });
        expect((await replace(bob, mine.id, "bob.jpg", await jpeg(100, 100))).ok).toBe(true);
        expect((await replace(eve, mine.id, "bob.jpg", await jpeg(120, 120))).ok).toBe(true);
        expect(await replace(anna, newId(), "x.jpg", await jpeg())).toMatchObject({
          ok: false,
          code: "not_found",
        });
      });

      test("a PDF is replaced and stays ready", async () => {
        const r = await upload(anna, "doc.pdf", PDF);
        const next = new TextEncoder().encode("%PDF-1.7\n%second\n");
        expect(await replace(anna, r.id, "other.pdf", next)).toMatchObject({
          ok: true,
          status: "ready",
        });
        const row = (await db.run("select * from media where id = ?", [r.id]))[0]!;
        expect(Number(row["size_bytes"])).toBe(next.length);
        expect(Buffer.from(await storage.get(String(row["storage_key"]))).toString()).toContain(
          "second",
        );
      });
    });

    describe("pages record the files they use", () => {
      const image = (src: string, children: unknown[] = []) => ({
        id: newId(),
        type: "image",
        props: { src, alt: "x" },
        content: [],
        children,
      });
      const para = (children: unknown[] = []) => ({
        id: newId(),
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "hi", styles: {} }],
        children,
      });
      const save = async (id: string, revision: number, blocks: unknown[]) => {
        const r = await saveContent(db.runner, anna, siteId, id, {
          title: "P",
          slugPart: "p",
          status: "draft",
          blocks,
          revision,
        });
        if (!r.ok) throw new Error(r.message);
        return r.revision;
      };
      const usedBy = async (mediaId: string) => {
        const r = await getMedia(db.runner, ctx, anna, siteId, mediaId);
        if (!r.ok) throw new Error(r.message);
        return r.usedIn.map((u) => u.title);
      };

      test("an image block that points at an uploaded file fills its Used-in list, and removing the block empties it", async () => {
        const a = await upload(anna, "a.png", await png());
        const b = await upload(anna, "b photo é.png", await png());
        const page = await createDraft(db.runner, anna, siteId, { type: "page", title: "P" });
        if (!page.ok) throw new Error("draft");
        const encoded = b.url; // /uploads/2026/11/<id>-b-photo-é.png with the accent encoded
        let revision = await save(page.id, 1, [image(a.url), para([image(encoded)])]);
        expect(await usedBy(a.id)).toEqual(["P"]);
        expect(await usedBy(b.id)).toEqual(["P"]);
        // The file is now in use: it cannot be deleted.
        expect(await deleteMedia(db.runner, ctx, anna, siteId, a.id)).toMatchObject({
          ok: false,
          code: "in_use",
        });
        revision = await save(page.id, revision, [image(a.url)]);
        expect(await usedBy(a.id)).toEqual(["P"]);
        expect(await usedBy(b.id)).toEqual([]);
        await save(page.id, revision, [para()]);
        expect(await usedBy(a.id)).toEqual([]);
        expect((await deleteMedia(db.runner, ctx, anna, siteId, a.id)).ok).toBe(true);
      });

      test("a link to one of the sizes counts as using the file", async () => {
        const a = await upload(anna, "a.jpg", await jpeg(700, 300));
        await drainJobs(db.runner, handlers());
        const got = await getMedia(db.runner, ctx, anna, siteId, a.id);
        if (!got.ok) throw new Error("get");
        const size = got.item.variants.find((v) => v.format === "webp")!;
        const page = await createDraft(db.runner, anna, siteId, { type: "page", title: "P" });
        if (!page.ok) throw new Error("draft");
        await save(page.id, 1, [image(size.url + "?v=2")]);
        expect(await usedBy(a.id)).toEqual(["P"]);
      });

      test("other addresses and unknown files are ignored", async () => {
        const page = await createDraft(db.runner, anna, siteId, { type: "page", title: "P" });
        if (!page.ok) throw new Error("draft");
        await save(page.id, 1, [
          image("https://example.com/uploads/2026/11/x.png"),
          image("/uploads/2026/11/nothing.png"),
          image("/other/a.png"),
        ]);
        expect(Number((await db.run("select count(*) as n from entry_media"))[0]!["n"])).toBe(0);
      });

      test("the keys are found at any depth, decoded, without a query", () => {
        const blocks = [
          para([image("/uploads/2026/11/a%20b.png?x=1#y"), para([image("/uploads/k/é.png")])]),
          image("/uploads/2026/11/bad%.png"),
        ] as unknown as Parameters<typeof uploadKeysIn>[0];
        expect(uploadKeysIn(blocks).sort()).toEqual(
          ["2026/11/a b.png", "2026/11/bad%.png", "k/é.png"].sort(),
        );
      });
    });

    describe("finding a file to serve", () => {
      test("the type and name come from the database, for the original and for each size", async () => {
        const r = await upload(anna, "Summer Photo.jpg", await jpeg(700, 300));
        await drainJobs(db.runner, handlers());
        const original = String(
          (await db.run("select storage_key from media where id = ?", [r.id]))[0]!["storage_key"],
        );
        expect(await findFile(db.runner, siteId, original)).toEqual({
          key: original,
          mimeType: "image/jpeg",
          fileName: "Summer-Photo.jpg",
        });
        const v = (
          await db.run(
            "select storage_key from media_variants where media_id = ? and width = 320 and format = 'avif'",
            [r.id],
          )
        )[0]!;
        expect(await findFile(db.runner, siteId, String(v["storage_key"]))).toEqual({
          key: String(v["storage_key"]),
          mimeType: "image/avif",
          fileName: "Summer-Photo-320.avif",
        });
      });

      test("an unknown key, or another site's, is not found", async () => {
        const r = await upload(anna, "a.png", await png());
        const key = String(
          (await db.run("select storage_key from media where id = ?", [r.id]))[0]!["storage_key"],
        );
        expect(await findFile(db.runner, siteId, "2026/11/nothing.png")).toBeNull();
        expect(await findFile(db.runner, newId(), key)).toBeNull();
      });

      test("a PDF is named as a PDF so the headers make it a download", async () => {
        const r = await upload(anna, "Menu.pdf", PDF);
        const key = String(
          (await db.run("select storage_key from media where id = ?", [r.id]))[0]!["storage_key"],
        );
        expect(await findFile(db.runner, siteId, key)).toMatchObject({
          mimeType: "application/pdf",
        });
      });
    });
  });
}
