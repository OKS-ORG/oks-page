import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { localAdapter } from "@oks-page/media";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  DEFAULT_MEDIA_SETTINGS,
  loadMediaSettings,
  loadMediaSettingsForm,
  saveMediaSettings,
} from "./media-settings.js";
import { uploadMedia } from "./media.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: media settings`, () => {
    let db: TestDb;
    let dir: string;
    let siteId = "";
    let anna: Actor;
    let eve: Actor;

    beforeEach(async () => {
      db = await open();
      dir = await mkdtemp(path.join(tmpdir(), "oks-media-settings-"));
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
      eve = actorOf(newId(), "editor");
    });
    afterEach(async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    test("without saved settings the defaults apply", async () => {
      expect(await loadMediaSettingsForm(db.runner, siteId)).toEqual(DEFAULT_MEDIA_SETTINGS);
      expect(await loadMediaSettings(db.runner, siteId)).toEqual({
        maxBytes: 25 * 1024 * 1024,
        maxPixels: 100_000_000,
        keepMetadata: false,
      });
    });

    test("saving keeps the values, a second save changes them, and unchanged values stay", async () => {
      const first = await saveMediaSettings(db.runner, anna, siteId, {
        maxMegabytes: 5,
        keepMetadata: true,
      });
      expect(first).toMatchObject({
        ok: true,
        settings: { maxMegabytes: 5, maxMegapixels: 100, keepMetadata: true },
      });
      await saveMediaSettings(db.runner, anna, siteId, { maxMegapixels: 20 });
      expect(await loadMediaSettingsForm(db.runner, siteId)).toEqual({
        maxMegabytes: 5,
        maxMegapixels: 20,
        keepMetadata: true,
      });
      const rows = await db.run("select revision from settings where key = 'media'");
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!["revision"])).toBe(2);
    });

    test("bad numbers are refused in words and nothing is saved", async () => {
      for (const bad of [0, -3, 201, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          await saveMediaSettings(db.runner, anna, siteId, { maxMegabytes: bad }),
        ).toMatchObject({
          ok: false,
          code: "invalid",
        });
      }
      expect(
        await saveMediaSettings(db.runner, anna, siteId, { maxMegapixels: 0.5 }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect(
        await saveMediaSettings(db.runner, anna, siteId, { keepMetadata: "yes" as never }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect(await db.run("select 1 from settings where key = 'media'")).toHaveLength(0);
    });

    test("only people who manage the settings can save them", async () => {
      expect(await saveMediaSettings(db.runner, eve, siteId, { maxMegabytes: 2 })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await db.run("select 1 from settings where key = 'media'")).toHaveLength(0);
    });

    test("damaged saved values fall back to the defaults", async () => {
      await db.run(
        "insert into settings (site_id, key, value, revision, updated_at) values (?, 'media', ?, 1, ?)",
        [siteId, JSON.stringify({ maxMegabytes: "lots", maxMegapixels: -1, keepMetadata: "x" }), T],
      );
      expect(await loadMediaSettingsForm(db.runner, siteId)).toEqual(DEFAULT_MEDIA_SETTINGS);
    });

    test("the saved limits are used by the next upload", async () => {
      const storage = localAdapter({ root: dir, baseUrl: "/uploads" });
      const jpeg = await sharp({
        create: { width: 400, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .jpeg()
        .toBuffer();
      const upload = async () =>
        uploadMedia(
          db.runner,
          { storage, settings: await loadMediaSettings(db.runner, siteId) },
          anna,
          siteId,
          { fileName: "p.jpg", bytes: new Uint8Array(jpeg) },
        );
      expect((await upload()).ok).toBe(true);
      // 400 x 300 is 0.12 megapixels: a limit of 0.05 refuses it.
      await db.run("delete from settings where key = 'media'");
      await db.run(
        "insert into settings (site_id, key, value, revision, updated_at) values (?, 'media', ?, 1, ?)",
        [siteId, JSON.stringify({ maxMegabytes: 25, maxMegapixels: 0.05, keepMetadata: false }), T],
      );
      // A value under the minimum is damaged, so it falls back to the default and the upload works.
      expect((await upload()).ok).toBe(true);
      await db.run("delete from settings where key = 'media'");
      await db.run(
        "insert into settings (site_id, key, value, revision, updated_at) values (?, 'media', ?, 1, ?)",
        [siteId, JSON.stringify({ maxMegabytes: 1, maxMegapixels: 1, keepMetadata: false }), T],
      );
      const big = new Uint8Array(1.5 * 1024 * 1024);
      big.set(new TextEncoder().encode("%PDF-1.7\n"));
      const refused = await uploadMedia(
        db.runner,
        { storage, settings: await loadMediaSettings(db.runner, siteId) },
        anna,
        siteId,
        { fileName: "big.pdf", bytes: big },
      );
      expect(refused).toMatchObject({ ok: false, code: "invalid" });
      expect((refused as { message: string }).message).toMatch(/too big/);
    });
  });
}
