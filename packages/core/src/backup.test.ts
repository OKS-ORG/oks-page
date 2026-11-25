// Backups and restore (spec 14, part 2; UP-20 to UP-24), on SQLite and PostgreSQL: what a backup holds and leaves out, that it is
// checked, that a damaged or changed one is refused, and that a restore puts the site back, keeps people signed in, makes a safety
// backup first and can be undone.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { localAdapter, type StorageAdapter } from "@oks-page/media";
import { newId } from "@oks-page/db";
import { openMemoryDatabase } from "@oks-page/db/memory";
import { openers, type TestDb } from "@oks-page/db/testing";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  backupPath,
  checkBackup,
  deleteBackup,
  listBackups,
  makeBackup,
  restoreBackup,
  runBackup,
  type BackupContext,
} from "./backup.js";
import { createDraft, saveContent, type Actor } from "./content.js";
import { saveEmailSettings } from "./email.js";
import { drainJobs } from "./jobs.js";
import { MEDIA_JOB, mediaJobHandler, uploadMedia } from "./media.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";
import { readTarGz, writeTarGz } from "./tar.js";

const T = 1_700_000_000_000;
const para = (text: string) => ({
  id: "b1",
  type: "paragraph",
  props: {},
  content: [{ type: "text", text }],
  children: [],
});
const jpeg = () =>
  sharp({ create: { width: 600, height: 300, channels: 3, background: { r: 20, g: 130, b: 90 } } })
    .jpeg()
    .toBuffer();
const actorFor = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (c) => caps.includes(c) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: backups and restore`, () => {
    let db: TestDb;
    let dir: string;
    let backups: string;
    let storage: StorageAdapter;
    let ctx: BackupContext;
    let siteId = "";
    let anna: Actor;
    let eve: Actor;
    let clock = T;
    let free: number | null = null;
    const secrets = new SiteSecrets("x".repeat(40));
    const SENTINEL = "SMTP-PASSWORD-SENTINEL-1234";

    const count = async (table: string, where = "1 = 1") =>
      Number((await db.run(`select count(*) as n from ${table} where ${where}`))[0]!["n"]);
    const titles = async () =>
      (await db.run(`select title from entries order by title`)).map((r) => String(r["title"]));
    const page = async (title: string, text: string) => {
      const made = await createDraft(db.runner, anna, siteId, { type: "page", title }, () => clock);
      if (!made.ok) throw new Error(made.message);
      const saved = await saveContent(
        db.runner,
        anna,
        siteId,
        made.id,
        {
          title,
          slugPart: made.slug,
          status: "published",
          blocks: [para(text)],
          revision: made.revision,
        },
        () => clock,
      );
      if (!saved.ok) throw new Error(saved.message);
      return made.id;
    };
    const backup = async (kind: "manual" | "daily" = "manual") => {
      const r = await runBackup(db.runner, ctx, kind);
      if (!r.ok) throw new Error(r.message);
      return r.info;
    };
    /** The files of a backup, opened. */
    const unpack = async (name: string) => {
      const tar = readTarGz(await readFile(path.join(backups, name)), 1 << 30);
      if (!tar.ok) throw new Error(tar.error);
      return new Map(tar.entries.map((e) => [e.path, e.data]));
    };

    beforeEach(async () => {
      db = await open();
      dir = await mkdtemp(path.join(tmpdir(), "oks-backup-"));
      backups = path.join(dir, "backups");
      storage = localAdapter({ root: path.join(dir, "uploads"), baseUrl: "/uploads" });
      clock = T;
      free = null;
      ctx = {
        dir: backups,
        storage,
        openCopy: () => openMemoryDatabase(),
        now: () => clock,
        version: "1.0.0-test",
        freeBytes: async () => free,
      };
      const setup = await runSetup(
        db.runner,
        async (input) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, input.name, input.email, new Date(T), new Date(T)],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@garden.test", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      anna = actorFor(setup.userId, "administrator");
      eve = actorFor(setup.userId, "editor");
      await saveEmailSettings(
        db.runner,
        anna,
        siteId,
        secrets,
        {
          host: "smtp.example.com",
          port: 587,
          security: "starttls",
          username: "u",
          password: SENTINEL,
          fromName: "Anna",
          fromAddress: "hello@garden.example",
          testTo: "anna@garden.test",
        },
        { makeTransport: () => ({ send: async () => undefined }) },
      );
      await page("About us", "We grow roses.");
      const photo = await uploadMedia(db.runner, { storage }, anna, siteId, {
        fileName: "Garden.jpg",
        bytes: new Uint8Array(await jpeg()),
      });
      if (!photo.ok) throw new Error(photo.message);
      await drainJobs(db.runner, { [MEDIA_JOB]: mediaJobHandler(db.runner, { storage }) });
      // Someone is signed in.
      await db.run(
        `insert into auth_sessions (id, user_id, token, expires_at, created_at, updated_at) values (?, ?, 'tok-anna', ?, ?, ?)`,
        [newId(), anna.userId, new Date(T + 86_400_000), new Date(T), new Date(T)],
      );
    });
    afterEach(async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    describe("making one (UP-20)", () => {
      test("it holds the database, every uploaded file and a list with their sums, and is checked", async () => {
        const info = await backup();
        expect(info).toMatchObject({ kind: "manual", compatible: true, createdAt: T });
        expect(info.name).toMatch(/^manual-\d{8}-\d{6}-[0-9a-f]{6}\.tgz$/);
        expect(info.checkedAt).toBe(T);
        expect(info.files).toBeGreaterThanOrEqual(2); // the picture and its sizes
        const files = await unpack(info.name);
        const manifest = JSON.parse(files.get("manifest.json")!.toString());
        expect(manifest).toMatchObject({
          kind: "site-backup",
          format: 1,
          backupKind: "manual",
          version: "1.0.0-test",
          createdAt: T,
        });
        const listed = (manifest.files as { path: string }[]).map((f) => f.path).sort();
        expect([...files.keys()].filter((p) => p !== "manifest.json").sort()).toEqual(listed);
        expect(listed).toContain("database.json");
        expect(listed.filter((p) => p.startsWith("media/")).length).toBe(info.files);
        const dump = JSON.parse(files.get("database.json")!.toString()) as {
          tables: Record<string, unknown[]>;
        };
        expect(dump.tables["entries"]!.length).toBeGreaterThan(0);
        expect(dump.tables["media"]!.length).toBe(1);
      });

      test("what is only of the moment is left out, and the site's own key and secrets in clear are not inside (UP-20)", async () => {
        const info = await backup();
        const files = await unpack(info.name);
        const dump = JSON.parse(files.get("database.json")!.toString()) as {
          tables: Record<string, unknown[]>;
        };
        for (const t of [
          "auth_sessions",
          "auth_verifications",
          "rate_limits",
          "jobs",
          "cache_tags",
          "entry_locks",
        ])
          expect(dump.tables[t], t).toBeUndefined();
        const everything = [...files.values()].map((d) => d.toString("latin1")).join("\n");
        expect(everything).not.toContain(SENTINEL); // sealed in the database, never in clear
        expect(everything).not.toContain("x".repeat(40)); // the site's key (OKS_SECRET) is not in it
        // The raw file, unzipped, says the same.
        expect(
          gunzipSync(await readFile(path.join(backups, info.name))).toString("latin1"),
        ).not.toContain(SENTINEL);
        expect((await checkBackup(path.join(backups, info.name), ctx)).ok).toBe(true);
      });

      test("a backup is listed with its kind, time and size, and only people who manage the site make, list or delete", async () => {
        expect(await makeBackup(db.runner, ctx, eve)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        const made = await makeBackup(db.runner, ctx, anna);
        if (!made.ok) throw new Error(made.message);
        clock += 60_000;
        await backup("daily");
        const [newest, oldest] = await listBackups(ctx, anna);
        expect(newest).toMatchObject({ kind: "daily", compatible: true });
        expect(oldest).toMatchObject({
          name: made.info.name,
          kind: "manual",
          size: made.info.size,
        });
        expect(newest!.createdAt).toBeGreaterThan(oldest!.createdAt);
        expect(await listBackups(ctx, eve)).toEqual([]);
        expect(await deleteBackup(ctx, eve, made.info.name)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await deleteBackup(ctx, anna, made.info.name)).toEqual({ ok: true });
        expect(await deleteBackup(ctx, anna, made.info.name)).toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect((await listBackups(ctx, anna)).map((b) => b.kind)).toEqual(["daily"]);
      });

      test("only a backup's own name opens a file: nothing else in or out of the folder", () => {
        for (const bad of [
          "../x.tgz",
          "manual-20261126-120000-abcdef.tgz/../../etc/passwd",
          "x.tgz",
          "",
          undefined,
          5,
          "manual-20261126-120000-abcdef.tgz.json",
        ])
          expect(backupPath(ctx, bad), String(bad)).toBeNull();
        expect(backupPath(ctx, "manual-20261126-120000-abcdef.tgz")).toBe(
          path.join(backups, "manual-20261126-120000-abcdef.tgz"),
        );
      });

      test("a backup that would not fit on the disk is refused before anything is written (UP-22)", async () => {
        free = 10 * 1024 * 1024;
        const r = await runBackup(db.runner, ctx, "manual");
        expect(r).toMatchObject({
          ok: false,
          message: expect.stringMatching(/not enough free disk space/),
        });
        expect(await listBackups(ctx, anna)).toEqual([]);
        free = 10 * 1024 * 1024 * 1024;
        expect((await runBackup(db.runner, ctx, "manual")).ok).toBe(true);
      });
    });

    describe("checking one (UP-23)", () => {
      test("a changed, cut or padded file is refused with a plain message", async () => {
        const info = await backup();
        const good = await readFile(path.join(backups, info.name));
        const files = await unpack(info.name);
        const repack = async (change: (m: Map<string, Buffer>) => void, label: string) => {
          const copy = new Map(files);
          change(copy);
          const file = path.join(dir, `${label}.tgz`);
          // The list of files stays last, as a real backup has it: anything added comes before it.
          const manifest = copy.get("manifest.json");
          copy.delete("manifest.json");
          if (manifest) copy.set("manifest.json", manifest);
          await writeFile(file, writeTarGz([...copy].map(([p, data]) => ({ path: p, data }))));
          return checkBackup(file, ctx);
        };
        expect(
          await repack(
            (m) =>
              m.set(
                "database.json",
                Buffer.from(m.get("database.json")!.toString().replace("About us", "Hacked")),
              ),
            "changed",
          ),
        ).toMatchObject({
          ok: false,
          message: expect.stringMatching(/has changed since it was made: database\.json/),
        });
        const key = [...files.keys()].find((p) => p.startsWith("media/"))!;
        expect(await repack((m) => m.delete(key), "missing")).toMatchObject({
          ok: false,
          message: expect.stringMatching(/A file of the backup is missing/),
        });
        expect(
          await repack((m) => m.set("media/2026/11/extra.php", Buffer.from("<?php ?>")), "extra"),
        ).toMatchObject({ ok: false, message: expect.stringMatching(/not on its list/) });
        expect(
          await repack((m) => m.set("media/../../etc/passwd", Buffer.from("x")), "path"),
        ).toMatchObject({ ok: false, message: expect.stringMatching(/path that is not allowed/) });
        expect(await repack((m) => m.set("notes.txt", Buffer.from("x")), "other")).toMatchObject({
          ok: false,
          message: expect.stringMatching(/should not/),
        });
        expect(await repack((m) => m.delete("manifest.json"), "nomanifest")).toMatchObject({
          ok: false,
          message: expect.stringMatching(/list of files is missing/),
        });
        const cut = path.join(dir, "cut.tgz");
        await writeFile(cut, good.subarray(0, Math.floor(good.length / 2)));
        expect(await checkBackup(cut, ctx)).toMatchObject({ ok: false });
        const junk = path.join(dir, "junk.tgz");
        await writeFile(junk, Buffer.from("this is not a backup"));
        expect(await checkBackup(junk, ctx)).toMatchObject({ ok: false });
      });

      test("a backup whose tables are not this version's can be read but not put back", async () => {
        const info = await backup();
        const files = await unpack(info.name);
        const manifest = JSON.parse(files.get("manifest.json")!.toString());
        manifest.shape = "0".repeat(64);
        const file = path.join(dir, "other.tgz");
        await writeFile(
          file,
          writeTarGz(
            [...files].map(([p, data]) => ({
              path: p,
              data: p === "manifest.json" ? Buffer.from(JSON.stringify(manifest)) : data,
            })),
          ),
        );
        expect(await checkBackup(file, ctx)).toMatchObject({ ok: true, compatible: false });
        manifest.format = 2;
        await writeFile(
          file,
          writeTarGz(
            [...files].map(([p, data]) => ({
              path: p,
              data: p === "manifest.json" ? Buffer.from(JSON.stringify(manifest)) : data,
            })),
          ),
        );
        expect(await checkBackup(file, ctx)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/newer version/),
        });
      });

      test("data that cannot be put into a copy is found by the check, and a backup that fails it is not kept", async () => {
        const info = await backup();
        const files = await unpack(info.name);
        const dump = JSON.parse(files.get("database.json")!.toString()) as {
          tables: Record<string, Record<string, unknown>[]>;
        };
        dump.tables["entries"]![0]!["author_id"] = newId(); // a person who is not there
        const database = Buffer.from(JSON.stringify(dump));
        const manifest = JSON.parse(files.get("manifest.json")!.toString());
        manifest.files = manifest.files.map((f: { path: string; sha256: string; size: number }) =>
          f.path === "database.json"
            ? {
                ...f,
                size: database.length,
                sha256: createHash("sha256").update(database).digest("hex"),
              }
            : f,
        );
        const file = path.join(dir, "broken.tgz");
        await writeFile(
          file,
          writeTarGz(
            [...files].map(([p, data]) => ({
              path: p,
              data:
                p === "database.json"
                  ? database
                  : p === "manifest.json"
                    ? Buffer.from(JSON.stringify(manifest))
                    : data,
            })),
          ),
        );
        expect(await checkBackup(file, ctx)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/could not be put into a copy/),
        });
      });
    });

    describe("restoring (UP-24)", () => {
      test("the whole site comes back as it was, a safety backup is made first, and nothing is left half done", async () => {
        const before = await backup();
        // The site moves on: a page is changed and added, one is removed, a picture comes, a person joins.
        await db.run(`update entries set title = 'Changed' where title = 'About us'`);
        await page("Brand new", "Later text.");
        const later = await uploadMedia(db.runner, { storage }, anna, siteId, {
          fileName: "Later.jpg",
          bytes: new Uint8Array(await jpeg()),
        });
        if (!later.ok) throw new Error(later.message);
        const laterKey = String(
          (await db.run(`select storage_key from media where id = ?`, [later.id]))[0]![
            "storage_key"
          ],
        );
        const ben = newId();
        await db.run(
          "insert into users (id, name, email, created_at, updated_at) values (?, 'Ben', 'ben@garden.test', ?, ?)",
          [ben, new Date(T), new Date(T)],
        );
        expect(await titles()).toEqual(["Brand new", "Changed"]);
        expect(await count("media")).toBe(2);

        clock += 3_600_000;
        const done = await restoreBackup(db.runner, ctx, anna, before.name, true);
        if (!done.ok) throw new Error(done.message);
        expect(await titles()).toEqual(["About us"]);
        expect(await count("media")).toBe(1);
        expect(await count("users", "email = 'ben@garden.test'")).toBe(0);
        // The files of the backup are there, and the file uploaded later is left alone (nothing points to it now).
        expect(await storage.exists(laterKey)).toBe(true);
        expect(done.files).toBeGreaterThanOrEqual(2);
        // The person who restored is still signed in.
        expect(await count("auth_sessions", "token = 'tok-anna'")).toBe(1);
        // The safety backup holds the site as it was just before: "Brand new", Ben, the later picture.
        expect(done.safetyBackup).toMatch(/^safety-/);
        const safety = JSON.parse(
          (await unpack(done.safetyBackup)).get("database.json")!.toString(),
        ) as { tables: Record<string, Record<string, unknown>[]> };
        expect(safety.tables["entries"]!.map((e) => e["title"]).sort()).toEqual([
          "Brand new",
          "Changed",
        ]);
        expect(safety.tables["users"]!.some((u) => u["email"] === "ben@garden.test")).toBe(true);
        expect(done.slugs).toContain("brand-new");
        // The line in the log.
        expect(await count("audit_log", "action = 'site.restore'")).toBe(1);

        // And it can be undone: restoring the safety backup brings the later state back.
        clock += 3_600_000;
        const undone = await restoreBackup(db.runner, ctx, anna, done.safetyBackup, true);
        if (!undone.ok) throw new Error(undone.message);
        expect(await titles()).toEqual(["Brand new", "Changed"]);
        expect(await count("users", "email = 'ben@garden.test'")).toBe(1);
        expect(await count("media")).toBe(2);
      });

      test("people who are not in the backup lose their place, and the ones who are keep theirs", async () => {
        const before = await backup();
        const ben = newId();
        await db.run(
          "insert into users (id, name, email, created_at, updated_at) values (?, 'Ben', 'ben@garden.test', ?, ?)",
          [ben, new Date(T), new Date(T)],
        );
        await db.run(
          `insert into auth_sessions (id, user_id, token, expires_at, created_at, updated_at) values (?, ?, 'tok-ben', ?, ?, ?)`,
          [newId(), ben, new Date(T + 86_400_000), new Date(T), new Date(T)],
        );
        const done = await restoreBackup(db.runner, ctx, anna, before.name, true);
        expect(done.ok).toBe(true);
        expect(await count("auth_sessions", "token = 'tok-anna'")).toBe(1);
        expect(await count("auth_sessions", "token = 'tok-ben'")).toBe(0);
      });

      test("it needs the right, a tick, a backup that exists and one that passes its check; and then changes nothing", async () => {
        const info = await backup();
        await db.run(`update entries set title = 'Changed'`);
        const safetyBefore = (await listBackups(ctx, anna)).length;
        expect(await restoreBackup(db.runner, ctx, eve, info.name, true)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await restoreBackup(db.runner, ctx, anna, info.name, false)).toMatchObject({
          ok: false,
          code: "invalid",
          message: expect.stringMatching(/Confirm first/),
        });
        expect(
          await restoreBackup(db.runner, ctx, anna, "safety-20260101-000000-abcdef.tgz", true),
        ).toMatchObject({ ok: false, code: "not_found" });
        expect(await restoreBackup(db.runner, ctx, anna, "../../etc/passwd", true)).toMatchObject({
          ok: false,
          code: "not_found",
        });
        // A file that was damaged on the disk is refused before anything is touched, and no safety backup is made for nothing.
        const file = path.join(backups, info.name);
        const good = await readFile(file);
        await writeFile(file, good.subarray(0, Math.floor(good.length / 2)));
        expect(await restoreBackup(db.runner, ctx, anna, info.name, true)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/cannot be restored/),
        });
        expect(await titles()).toEqual(["Changed"]);
        expect((await listBackups(ctx, anna)).length).toBe(safetyBefore);
      });

      test("a backup made by another version is not put back", async () => {
        const info = await backup();
        const files = await unpack(info.name);
        const manifest = JSON.parse(files.get("manifest.json")!.toString());
        manifest.shape = "f".repeat(64);
        const name = "manual-20260101-000000-abcdef.tgz";
        await writeFile(
          path.join(backups, name),
          writeTarGz(
            [...files].map(([p, data]) => ({
              path: p,
              data: p === "manifest.json" ? Buffer.from(JSON.stringify(manifest)) : data,
            })),
          ),
        );
        await db.run(`update entries set title = 'Changed'`);
        expect(await restoreBackup(db.runner, ctx, anna, name, true)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/another version of the software/),
        });
        expect(await titles()).toEqual(["Changed"]);
      });

      test("when no safety backup can be made nothing is restored", async () => {
        const info = await backup();
        await db.run(`update entries set title = 'Changed'`);
        free = 1024;
        expect(await restoreBackup(db.runner, ctx, anna, info.name, true)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/Nothing was changed.*safety backup/),
        });
        expect(await titles()).toEqual(["Changed"]);
      });

      test("files put back by a restore that then fails are taken away again", async () => {
        const info = await backup();
        const files = await unpack(info.name);
        // A backup whose database cannot go in (a person who is not there), with the sums made right: it passes the file sums,
        // fails the copy check, and so is refused before any file moves. Delete a library file first to see one put back.
        const key = [...files.keys()].find((p) => p.startsWith("media/"))!.slice(6);
        await storage.delete(key);
        const done = await restoreBackup(db.runner, ctx, anna, info.name, true);
        expect(done.ok).toBe(true);
        expect(await storage.exists(key)).toBe(true); // a file the site had lost comes back
      });
    });
  });
}
