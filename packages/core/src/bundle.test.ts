// The site bundle (spec 11, section 9; AG-70 to AG-76, AG-87), on SQLite and PostgreSQL: what goes in and what stays out,
// that a bundle comes back whole on another site, and that a damaged, changed, padded or hostile bundle is refused before
// anything is changed.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { localAdapter, type StorageAdapter } from "@oks-page/media";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BUNDLE_SETTINGS, checkBundle, exportBundle, importBundle } from "./bundle.js";
import { createDraft, type Actor } from "./content.js";
import { drainJobs } from "./jobs.js";
import { MEDIA_JOB, mediaJobHandler, uploadMedia } from "./media.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import { readTarGz, writeTarGz } from "./tar.js";

const T = new Date(1_700_000_000_000);
const can = (role: string): Actor["can"] => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return (c) => caps.includes(c);
};
const jpeg = () =>
  sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg()
    .toBuffer();
const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const DIRTY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" onclick="x()"/></svg>';
const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

/** Opens the bundle's files as a map (so a test can change one). */
function unpack(archive: Buffer): Map<string, Buffer> {
  const tar = readTarGz(archive, 1 << 30);
  if (!tar.ok) throw new Error(tar.error);
  return new Map(tar.entries.filter((e) => e.kind === "file").map((e) => [e.path, e.data]));
}
/** Changes the files and makes the list right again, as a careful person (or a hostile one) would. */
function repack(archive: Buffer, edit: (files: Map<string, Buffer>) => void): Buffer {
  const files = unpack(archive);
  edit(files);
  const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8")) as {
    files: unknown;
  };
  files.delete("manifest.json");
  manifest.files = [...files].map(([p, d]) => ({ path: p, sha256: sha(d), size: d.length }));
  return writeTarGz([
    { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    ...[...files].map(([p, data]) => ({ path: p, data })),
  ]);
}
/** Changes the files and leaves the list as it was. */
function tamper(archive: Buffer, edit: (files: Map<string, Buffer>) => void): Buffer {
  const files = unpack(archive);
  edit(files);
  return writeTarGz([...files].map(([p, data]) => ({ path: p, data })));
}
/** A JSON column as a value: SQLite gives text, PostgreSQL gives the value. */
const asJson = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);
// A test reads a file of the bundle as loose JSON to change one value in it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonOf = (files: Map<string, Buffer>, name: string): Record<string, any> =>
  JSON.parse(files.get(name)!.toString("utf8"));

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the site bundle`, () => {
    let a: TestDb; // the site the bundle comes from
    let b: TestDb; // the site that takes it
    let dirA: string;
    let dirB: string;
    let storeA: StorageAdapter;
    let storeB: StorageAdapter;
    let siteA = "";
    let siteB = "";
    let annaA: Actor;
    let annaB: Actor;
    let photoKey = "";

    const makeSite = async (db: TestDb, name: string, email: string) => {
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
        { siteName: name, admin: { name: "Anna", email, password: "a-long-password" } },
      );
      return { siteId: setup.siteId, actor: { userId: setup.userId, can: can("administrator") } };
    };
    const setting = (db: TestDb, siteId: string, key: string, value: unknown) =>
      db.run(
        `insert into settings (site_id, key, value, revision, updated_at) values (?, ?, ?, 1, ?)`,
        [siteId, key, JSON.stringify(value), T],
      );
    const publish = (db: TestDb, id: string, html: string) =>
      db.run(
        `update entries set status = 'published', html = ?, plain_text = ?, published_at = ? where id = ?`,
        [html, html.replace(/<[^>]+>/g, ""), T, id],
      );
    const titles = async (db: TestDb, siteId: string) =>
      (
        await db.run(`select title, slug, status from entries where site_id = ? order by slug`, [
          siteId,
        ])
      ).map((r) => `${String(r["slug"])}:${String(r["status"])}:${String(r["title"])}`);
    const exported = async () => {
      const r = await exportBundle(a.runner, storeA, annaA, siteA);
      if (!r.ok) throw new Error(r.message);
      return r;
    };
    const importing = (archive: Buffer, extra: { maxUnpackedBytes?: number } = {}) =>
      importBundle(b.runner, storeB, annaB, siteB, archive, { replace: true, ...extra });

    beforeEach(async () => {
      a = await open();
      b = await open();
      dirA = await mkdtemp(path.join(tmpdir(), "oks-bundle-a-"));
      dirB = await mkdtemp(path.join(tmpdir(), "oks-bundle-b-"));
      storeA = localAdapter({ root: dirA, baseUrl: "/uploads" });
      storeB = localAdapter({ root: dirB, baseUrl: "/uploads" });
      ({ siteId: siteA, actor: annaA } = await makeSite(a, "Anna's Garden", "anna@garden.test"));
      ({ siteId: siteB, actor: annaB } = await makeSite(b, "Brand New", "owner@client.test"));

      // Site A has content: pages (one under another), a post, a trashed page, a picture and a drawing, a menu, settings.
      const about = await createDraft(a.runner, annaA, siteA, { type: "page", title: "About us" });
      const team = await createDraft(a.runner, annaA, siteA, { type: "page", title: "Our team" });
      const post = await createDraft(a.runner, annaA, siteA, { type: "post", title: "First post" });
      const gone = await createDraft(a.runner, annaA, siteA, { type: "page", title: "Old news" });
      if (!about.ok || !team.ok || !post.ok || !gone.ok) throw new Error("setup");
      await publish(a, about.id, "<p>About the garden</p>");
      await publish(a, team.id, "<p>Anna and Bob</p>");
      await publish(a, post.id, "<p>Hello world</p>");
      await a.run(`update entries set parent_id = ? where id = ?`, [about.id, team.id]);
      await a.run(`update entries set status = 'trash', trashed_at = ? where id = ?`, [T, gone.id]);

      const ctx = { storage: storeA };
      const photo = await uploadMedia(a.runner, ctx, annaA, siteA, {
        fileName: "Garden.jpg",
        bytes: new Uint8Array(await jpeg()),
      });
      const drawing = await uploadMedia(a.runner, ctx, annaA, siteA, {
        fileName: "Logo.svg",
        bytes: new TextEncoder().encode(CLEAN_SVG),
      });
      if (!photo.ok || !drawing.ok) throw new Error("upload");
      await drainJobs(a.runner, { [MEDIA_JOB]: mediaJobHandler(a.runner, ctx) });
      photoKey = (await a.run(`select storage_key from media where id = ?`, [photo.id]))[0]![
        "storage_key"
      ] as string;
      await a.run(`insert into entry_media (entry_id, media_id, field) values (?, ?, 'body')`, [
        about.id,
        photo.id,
      ]);
      await a.run(
        `insert into menus (id, site_id, key, label, items, updated_at) values (?, ?, 'header', 'Header', ?, ?)`,
        [newId(), siteA, JSON.stringify([{ label: "About", href: "/about-us" }]), T],
      );
      await setting(a, siteA, "site-language", { code: "de" });
      await setting(a, siteA, "reading", { postsPerPage: 7 });
      // Settings that must never travel.
      await setting(a, siteA, "email", {
        password: "SMTP-PASSWORD-SENTINEL",
        host: "mail.example",
      });
      await setting(a, siteA, "security", { recovery: "RECOVERY-CODE-SENTINEL" });
      await setting(a, siteA, "licences", { keys: ["OKS1.LICENCE-KEY-SENTINEL.sig"] });
      await setting(a, siteA, "publish-targets", { token: "PUBLISH-TOKEN-SENTINEL" });
      // Site B has its own secret and its own old page.
      await setting(b, siteB, "email", { password: "B-OWN-PASSWORD", host: "mail.b.example" });
      const old = await createDraft(b.runner, annaB, siteB, { type: "page", title: "Placeholder" });
      if (!old.ok) throw new Error("setup b");
      await publish(b, old.id, "<p>Coming soon</p>");
    });
    afterEach(async () => {
      await a.close();
      await b.close();
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    });

    describe("what goes in, and what stays out (AG-70)", () => {
      test("the bundle lists its files and holds the content, the settings and every uploaded file", async () => {
        const r = await exported();
        const files = unpack(r.archive);
        const manifest = jsonOf(files, "manifest.json");
        expect(manifest).toMatchObject({
          kind: "site-bundle",
          format: 1,
          siteName: "Anna's Garden",
        });
        const listed = (manifest["files"] as { path: string; sha256: string; size: number }[]).map(
          (f) => f.path,
        );
        expect(listed).toContain("content.json");
        expect(listed).toContain("settings.json");
        expect(listed).toContain(`media/${photoKey}`);
        // The original, its sizes and the drawing: nothing is listed that is not in the file, and the other way round.
        expect([...files.keys()].filter((p) => p !== "manifest.json").sort()).toEqual(
          [...listed].sort(),
        );
        for (const f of manifest["files"] as { path: string; sha256: string; size: number }[]) {
          expect(sha(files.get(f.path)!)).toBe(f.sha256);
          expect(files.get(f.path)!.length).toBe(f.size);
        }
        expect(r.counts).toMatchObject({ entries: 3, media: 2, menus: 1 });
        expect(r.skipped).toEqual([]);
      });

      test("no secret, person or sign-in detail is inside, and only listed settings are carried (AG-70)", async () => {
        const r = await exported();
        const everything = [...unpack(r.archive).values()]
          .map((d) => d.toString("latin1"))
          .join("\n");
        for (const sentinel of [
          "SMTP-PASSWORD-SENTINEL",
          "RECOVERY-CODE-SENTINEL",
          "LICENCE-KEY-SENTINEL",
          "PUBLISH-TOKEN-SENTINEL",
          "anna@garden.test",
          "a-long-password",
        ])
          expect(everything, sentinel).not.toContain(sentinel);
        const settings = jsonOf(unpack(r.archive), "settings.json")["settings"] as Record<
          string,
          unknown
        >;
        expect(Object.keys(settings).sort()).toEqual(["reading", "site-language"]);
        for (const key of Object.keys(settings)) expect(BUNDLE_SETTINGS).toContain(key as never);
        // The raw tar holds the same, unzipped.
        expect(gunzipSync(r.archive).toString("latin1")).not.toContain("SMTP-PASSWORD-SENTINEL");
      });

      test("a trashed page is left out, and a page whose parent is gone stands on its own", async () => {
        const files = unpack((await exported()).archive);
        const rows = jsonOf(files, "content.json")["tables"]["entries"] as Record<
          string,
          unknown
        >[];
        expect(rows.map((e) => e["title"]).sort()).toEqual(["About us", "First post", "Our team"]);
        expect(rows.every((e) => e["author_id"] === null)).toBe(true);
      });

      test("the person who exports needs the right to export", async () => {
        const editor: Actor = { userId: annaA.userId, can: can("editor") };
        const r = await exportBundle(a.runner, storeA, editor, siteA);
        expect(r).toMatchObject({ ok: false, code: "forbidden" });
      });

      test("a library file that is missing from storage is left out and named, and the rest still exports", async () => {
        await storeA.delete(photoKey);
        const r = await exported();
        expect(r.skipped).toEqual(["Garden.jpg"]);
        expect(r.counts.media).toBe(1);
        expect(unpack(r.archive).has(`media/${photoKey}`)).toBe(false);
        const check = await checkBundle(r.archive);
        expect(check.ok).toBe(true);
      });
    });

    describe("a bundle comes back whole on another site (AG-87)", () => {
      test("pages, posts, media, menus and settings arrive; the new site keeps its own people and secrets", async () => {
        const r = await exported();
        const done = await importing(r.archive);
        expect(done).toMatchObject({
          ok: true,
          counts: { entries: 3, media: 2, menus: 1 },
          siteName: "Anna's Garden",
        });
        expect(await titles(b, siteB)).toEqual(
          await titles(a, siteA).then((t) => t.filter((x) => !x.includes("Old news"))),
        );
        // The old placeholder page is gone, the new pages belong to the person who imported.
        expect((await titles(b, siteB)).join()).not.toContain("Placeholder");
        const authors = await b.run(`select distinct author_id from entries where site_id = ?`, [
          siteB,
        ]);
        expect(authors.map((x) => x["author_id"])).toEqual([annaB.userId]);
        // The text, the order of the pages and the link to the picture.
        const html = await b.run(
          `select html from entries where site_id = ? and slug = 'about-us'`,
          [siteB],
        );
        expect(html[0]!["html"]).toBe("<p>About the garden</p>");
        const parent = await b.run(
          `select p.slug from entries c join entries p on p.id = c.parent_id where c.site_id = ? and c.slug = 'our-team'`,
          [siteB],
        );
        expect(parent[0]!["slug"]).toBe("about-us");
        const used = await b.run(`select count(*) as n from entry_media where field = 'body'`);
        expect(Number(used[0]!["n"])).toBe(1);
        // The files, byte for byte, and their sizes.
        expect(
          Buffer.from(await storeB.get(photoKey)).equals(Buffer.from(await storeA.get(photoKey))),
        ).toBe(true);
        const variants = await b.run(`select storage_key from media_variants`);
        expect(variants.length).toBeGreaterThan(0);
        for (const v of variants) expect(await storeB.exists(String(v["storage_key"]))).toBe(true);
        expect(
          (await b.run(`select uploaded_by from media`)).every(
            (m) => m["uploaded_by"] === annaB.userId,
          ),
        ).toBe(true);
        // Menus and settings.
        expect(
          (await b.run(`select key from menus where site_id = ?`, [siteB])).map((m) => m["key"]),
        ).toEqual(["header"]);
        const lang = await b.run(
          `select value from settings where site_id = ? and key = 'site-language'`,
          [siteB],
        );
        expect(asJson(lang[0]!["value"])).toEqual({ code: "de" });
        // What belongs to the new site stays: its name, its secret, its people.
        expect((await b.run(`select name from sites where id = ?`, [siteB]))[0]!["name"]).toBe(
          "Brand New",
        );
        const email = await b.run(
          `select value from settings where site_id = ? and key = 'email'`,
          [siteB],
        );
        expect(JSON.stringify(asJson(email[0]!["value"]))).toContain("B-OWN-PASSWORD");
        expect(Number((await b.run(`select count(*) as n from users`))[0]!["n"])).toBe(1);
      });

      test("the files of the replaced site that the bundle does not use are taken away", async () => {
        const old = await uploadMedia(b.runner, { storage: storeB }, annaB, siteB, {
          fileName: "Old.svg",
          bytes: new TextEncoder().encode(CLEAN_SVG),
        });
        if (!old.ok) throw new Error("upload");
        const oldKey = String(
          (await b.run(`select storage_key from media where id = ?`, [old.id]))[0]!["storage_key"],
        );
        expect(await storeB.exists(oldKey)).toBe(true);
        expect((await importing((await exported()).archive)).ok).toBe(true);
        expect(await storeB.exists(oldKey)).toBe(false);
        expect(await storeB.exists(photoKey)).toBe(true);
      });

      test("a site can take back its own bundle, and its files stay", async () => {
        const r = await exported();
        const before = await titles(a, siteA);
        const again = await importBundle(a.runner, storeA, annaA, siteA, r.archive, {
          replace: true,
        });
        expect(again.ok).toBe(true);
        expect(await titles(a, siteA)).toEqual(before.filter((x) => !x.includes("Old news")));
        expect(await storeA.exists(photoKey)).toBe(true);
        expect((await exportBundle(a.runner, storeA, annaA, siteA)).ok).toBe(true);
      });

      test("a theme the new site does not have is named, not taken", async () => {
        const archive = repack((await exported()).archive, (files) => {
          const content = jsonOf(files, "content.json");
          content["tables"]["themes"] = [
            {
              id: newId(),
              site_id: siteA,
              key: "no-such-theme",
              version: "1.0.0",
              source: "build",
              is_active: true,
              settings: {},
            },
          ];
          files.set("content.json", Buffer.from(JSON.stringify(content)));
        });
        const done = await importing(archive);
        expect(done).toMatchObject({ ok: true, skippedThemes: ["no-such-theme"] });
      });
    });

    describe("a bundle that is not right is refused before anything changes (AG-71 to AG-76)", () => {
      const untouched = async () => {
        expect((await titles(b, siteB)).join()).toContain("Placeholder");
        expect(Number((await b.run(`select count(*) as n from media`))[0]!["n"])).toBe(0);
      };

      test("a changed file (AG-71)", async () => {
        const archive = tamper((await exported()).archive, (files) => {
          files.set(
            "content.json",
            Buffer.from(files.get("content.json")!.toString().replace("About us", "Hacked")),
          );
        });
        expect(await importing(archive)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/changed after the bundle was made: content\.json/),
        });
        await untouched();
      });

      test("a missing file (AG-72)", async () => {
        const archive = tamper((await exported()).archive, (files) =>
          files.delete(`media/${photoKey}`),
        );
        expect(await importing(archive)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/missing from the bundle/),
        });
        await untouched();
      });

      test("an extra file that is not on the list, such as a .php file in the media folder (AG-73)", async () => {
        const archive = tamper((await exported()).archive, (files) =>
          files.set("media/2026/11/shell.php", Buffer.from("<?php system($_GET['c']); ?>")),
        );
        expect(await importing(archive)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/not on its list: media\/2026\/11\/shell\.php/),
        });
        await untouched();
      });

      test("a path that leaves the folder (AG-74)", async () => {
        for (const bad of [
          "../../etc/passwd",
          "/etc/passwd",
          "media/../../x",
          "C:/x",
          "media\\..\\x",
        ]) {
          const archive = repack((await exported()).archive, (files) =>
            files.set(bad, Buffer.from("x")),
          );
          const r = await importing(archive);
          expect(r, bad).toMatchObject({ ok: false });
          expect((r as { message: string }).message, bad).toMatch(/path that is not allowed/);
        }
        await untouched();
      });

      test("a bundle from a newer format (AG-75)", async () => {
        const archive = tamper((await exported()).archive, (files) => {
          const m = jsonOf(files, "manifest.json");
          m["format"] = 2;
          files.set("manifest.json", Buffer.from(JSON.stringify(m)));
        });
        expect(await importing(archive)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/newer version/),
        });
        await untouched();
      });

      test("a bundle over the size cap (AG-76)", async () => {
        const r = await importing((await exported()).archive, { maxUnpackedBytes: 2000 });
        expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/too large/) });
        await untouched();
      });

      test("something that is not a bundle at all", async () => {
        expect(await importing(Buffer.from("hello"))).toMatchObject({ ok: false });
        const other = writeTarGz([{ path: "readme.txt", data: Buffer.from("hi") }]);
        expect(await importing(other)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/not a site bundle/),
        });
        await untouched();
      });

      test("a setting that is never imported, even when the list is made right", async () => {
        const archive = repack((await exported()).archive, (files) => {
          const s = jsonOf(files, "settings.json");
          s["settings"]["email"] = { password: "x" };
          files.set("settings.json", Buffer.from(JSON.stringify(s)));
        });
        expect(await importing(archive)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/never imported: email/),
        });
        await untouched();
      });

      test("a record that points at a file that is not a picture or document is refused, though the list is right", async () => {
        const archive = repack((await exported()).archive, (files) => {
          const c = jsonOf(files, "content.json");
          const m = c["tables"]["media"].find(
            (x: Record<string, unknown>) => x["filename"] === "Garden.jpg",
          );
          const key = String(m["storage_key"]);
          files.set(`media/${key}`, Buffer.from("<?php echo 1; ?>"));
          files.set("content.json", Buffer.from(JSON.stringify(c)));
        });
        expect(await importing(archive)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/refused/),
        });
        await untouched();
      });

      test("a file that no record uses is refused", async () => {
        const archive = repack((await exported()).archive, (files) =>
          files.set("media/2026/11/loose.jpg", Buffer.from("x")),
        );
        expect(await importing(archive)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/no record uses/),
        });
        await untouched();
      });

      test("a drawing with a script is stored cleaned", async () => {
        const archive = repack((await exported()).archive, (files) => {
          const c = jsonOf(files, "content.json");
          const m = c["tables"]["media"].find(
            (x: Record<string, unknown>) => x["filename"] === "Logo.svg",
          );
          files.set(`media/${String(m["storage_key"])}`, Buffer.from(DIRTY_SVG));
        });
        const done = await importing(archive);
        expect(done.ok).toBe(true);
        const key = String(
          (await b.run(`select storage_key from media where filename = 'Logo.svg'`))[0]![
            "storage_key"
          ],
        );
        const stored = Buffer.from(await storeB.get(key)).toString();
        expect(stored).not.toContain("<script");
        expect(stored).not.toContain("onclick");
      });

      test("a row with columns it should not have", async () => {
        const archive = repack((await exported()).archive, (files) => {
          const c = jsonOf(files, "content.json");
          c["tables"]["menus"][0]["extra"] = 1;
          files.set("content.json", Buffer.from(JSON.stringify(c)));
        });
        expect(await importing(archive)).toMatchObject({
          ok: false,
          message: expect.stringMatching(/columns/),
        });
        await untouched();
      });

      test("records that cannot be stored leave the site and the files as they were", async () => {
        const archive = repack((await exported()).archive, (files) => {
          const c = jsonOf(files, "content.json");
          // Two pages with one address: the database refuses the second.
          const clash = { ...c["tables"]["entries"][0], id: newId() };
          c["tables"]["entries"].push(clash);
          files.set("content.json", Buffer.from(JSON.stringify(c)));
        });
        const r = await importing(archive);
        expect(r).toMatchObject({
          ok: false,
          message: expect.stringMatching(/nothing was changed/),
        });
        await untouched();
        expect(await storeB.exists(photoKey)).toBe(false);
      });

      test("nobody imports without the right, or without saying it replaces", async () => {
        const archive = (await exported()).archive;
        const editor: Actor = { userId: annaB.userId, can: can("editor") };
        expect(
          await importBundle(b.runner, storeB, editor, siteB, archive, { replace: true }),
        ).toMatchObject({ ok: false, code: "forbidden" });
        expect(
          await importBundle(b.runner, storeB, annaB, siteB, archive, { replace: false }),
        ).toMatchObject({ ok: false, code: "invalid" });
        await untouched();
      });
    });
  });
}
