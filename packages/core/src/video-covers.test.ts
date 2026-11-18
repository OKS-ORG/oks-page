// The stored picture of a video block (spec 06, 14.3; PB-94): fetched once when the page is saved, kept in the block, and a
// failure only leaves the picture out. On SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, loadForEdit, saveContent, type Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import { MAX_COVERS_PER_SAVE, setCoverProvider } from "./video-covers.js";

const T = new Date(1_700_000_000_000);
const video = (src: string, id = newId(), props: Record<string, unknown> = {}) => ({
  id,
  type: "video",
  props: { src, ...props },
  content: null,
  children: [],
});
const YT = (id: string) => `https://www.youtube.com/watch?v=${id}`;

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the stored picture of a video`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let calls: string[] = [];

    beforeEach(async () => {
      db = await open();
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
      const caps = DEFAULT_ROLES.find((r) => r.key === "administrator")!.capabilities;
      anna = { userId: setup.userId, can: (c) => caps.includes(c) };
      calls = [];
      setCoverProvider(async (_site, v) => {
        calls.push(`${v.company}:${v.id}`);
        return `/uploads/cover-${v.id}.jpg`;
      });
    });
    afterEach(async () => {
      setCoverProvider(null);
      await db.close();
    });

    async function save(blocks: unknown[], target?: { id: string; revision: number }) {
      const made = target
        ? null
        : await createDraft(db.runner, anna, siteId, { type: "page", title: "V" });
      if (made && !made.ok) throw new Error(made.message);
      const id = target ? target.id : made!.ok ? made!.id : "";
      const revision = target ? target.revision : made!.ok ? made!.revision : 0;
      const loaded = await loadForEdit(db.runner, anna, siteId, id);
      if (!loaded.ok) throw new Error(loaded.message);
      const slugPart = loaded.entry.slugPart;
      const saved = await saveContent(db.runner, anna, siteId, id, {
        title: "V",
        slugPart,
        status: "draft",
        blocks,
        revision,
      });
      if (!saved.ok) throw new Error(saved.message);
      return { id, revision: saved.revision };
    }
    const storedBlocks = async (id: string) => {
      const loaded = await loadForEdit(db.runner, anna, siteId, id);
      if (!loaded.ok) throw new Error(loaded.message);
      return loaded.entry.blocks as { props: Record<string, unknown> }[];
    };

    test("a video gets its picture when the page is saved, and keeps it: the second save does not fetch it again", async () => {
      const first = await save([video(YT("dQw4w9WgXcQ"))]);
      expect(calls).toEqual(["YouTube:dQw4w9WgXcQ"]);
      const stored = await storedBlocks(first.id);
      expect(stored[0]!.props["cover"]).toBe("/uploads/cover-dQw4w9WgXcQ.jpg");
      // The editor sends the blocks back as it loaded them: the picture is there, so it is not fetched again.
      await save(stored, first);
      expect(calls).toHaveLength(1);
      expect((await storedBlocks(first.id))[0]!.props["cover"]).toBe(
        "/uploads/cover-dQw4w9WgXcQ.jpg",
      );
    });

    test("another video address gets another picture, and a stale picture is not kept", async () => {
      const first = await save([video(YT("dQw4w9WgXcQ"))]);
      const stored = await storedBlocks(first.id);
      const changed = [{ ...stored[0]!, props: { ...stored[0]!.props, src: YT("abcdefghijk") } }];
      await save(changed, first);
      expect(calls).toEqual(["YouTube:dQw4w9WgXcQ", "YouTube:abcdefghijk"]);
      expect((await storedBlocks(first.id))[0]!.props["cover"]).toBe(
        "/uploads/cover-abcdefghijk.jpg",
      );
    });

    test("a picture that cannot be fetched leaves the block without one, and the page still saves", async () => {
      setCoverProvider(async () => null);
      const done = await save([video(YT("dQw4w9WgXcQ"), "v1", { cover: "/uploads/old.jpg" })]);
      expect((await storedBlocks(done.id))[0]!.props["cover"]).toBeUndefined();
      setCoverProvider(async () => {
        throw new Error("network down");
      });
      const again = await save([video(YT("dQw4w9WgXcQ"))]);
      expect((await storedBlocks(again.id))[0]!.props["cover"]).toBeUndefined();
    });

    test("a video from another host is not fetched, and a page with many videos fetches only a few", async () => {
      await save([video("https://evil.test/v.mp4")]);
      expect(calls).toEqual([]);
      const many = Array.from({ length: MAX_COVERS_PER_SAVE + 3 }, (_, i) =>
        video(YT(`video-id-${String(i).padStart(2, "0")}`)),
      );
      await save(many);
      expect(calls).toHaveLength(MAX_COVERS_PER_SAVE);
    });
  });
}
