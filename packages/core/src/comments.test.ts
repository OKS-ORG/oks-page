// Comments on posts: off by default, wait for approval, plain text, moderation. On SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addComment,
  approvedComments,
  checkCommentInput,
  commentsEnabled,
  listComments,
  moderateComment,
  pendingCommentCount,
  saveCommentsEnabled,
} from "./comments.js";
import { createDraft, saveContent, type Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("what a visitor may send", () => {
  test("a name and a text are needed, and the limits are plain", () => {
    expect(checkCommentInput({ name: " ", content: "Hi" })).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(checkCommentInput({ name: "Ann", content: "  " })).toMatchObject({
      ok: false,
      field: "content",
    });
    expect(checkCommentInput({ name: "A".repeat(81), content: "Hi" })).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(checkCommentInput({ name: "Ann", content: "x".repeat(2001) })).toMatchObject({
      ok: false,
      field: "content",
    });
    expect(
      checkCommentInput({
        name: "Ann",
        content: "see http://a.example http://b.example https://c.example",
      }),
    ).toMatchObject({ ok: false, field: "content" });
    expect(checkCommentInput({ name: " Ann ", content: "Nice\r\npost " })).toEqual({
      ok: true,
      name: "Ann",
      content: "Nice\npost",
    });
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: comments`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let writer: Actor;
    let postId = "";

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
      anna = actorOf(setup.userId, "administrator");
      const wid = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [wid, "Wim", "wim@example.com", T, T],
      );
      writer = actorOf(wid, "contributor");
      const made = await createDraft(db.runner, anna, siteId, { type: "post", title: "Hello" });
      if (!made.ok) throw new Error("setup");
      postId = made.id;
      const live = await saveContent(db.runner, anna, siteId, postId, {
        title: "Hello",
        slugPart: "hello",
        status: "published",
        blocks: [
          {
            id: "p1",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "Hi", styles: {} }],
            children: [],
          },
        ],
        revision: 1,
      });
      if (!live.ok) throw new Error("setup publish");
    });
    afterEach(async () => db.close());

    test("comments are off for a new site, and only people who manage the settings turn them on", async () => {
      expect(await commentsEnabled(db.runner, siteId)).toBe(false);
      expect(
        await addComment(db.runner, siteId, { entryId: postId, name: "Ann", content: "Hi" }),
      ).toMatchObject({
        ok: false,
        code: "closed",
      });
      expect(await saveCommentsEnabled(db.runner, writer, siteId, true)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await saveCommentsEnabled(db.runner, anna, siteId, "yes")).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await saveCommentsEnabled(db.runner, anna, siteId, true)).toEqual({
        ok: true,
        enabled: true,
      });
      expect(await commentsEnabled(db.runner, siteId)).toBe(true);
      // Saving again replaces the value (a second row would break the key).
      expect(await saveCommentsEnabled(db.runner, anna, siteId, false)).toEqual({
        ok: true,
        enabled: false,
      });
    });

    test("a comment waits, is approved, then shows; spam and the trash never show", async () => {
      await saveCommentsEnabled(db.runner, anna, siteId, true);
      const sent = await addComment(db.runner, siteId, {
        entryId: postId,
        name: "Ann",
        content: "<b>Nice</b>\npost",
      });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      expect((await approvedComments(db.runner, siteId, postId)).comments).toEqual([]);
      expect(await pendingCommentCount(db.runner, siteId)).toBe(1);
      const waiting = await listComments(db.runner, anna, siteId, "pending");
      expect(waiting.ok && waiting.comments.map((c) => [c.name, c.entryTitle])).toEqual([
        ["Ann", "Hello"],
      ]);
      expect(await moderateComment(db.runner, writer, siteId, sent.id, "approve")).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await moderateComment(db.runner, anna, siteId, sent.id, "approve")).toMatchObject({
        ok: true,
        entryId: postId,
      });
      const shown = await approvedComments(db.runner, siteId, postId);
      // Stored as text, exactly as sent (the page draws it as text).
      expect(shown.comments.map((c) => c.content)).toEqual(["<b>Nice</b>\npost"]);
      await moderateComment(db.runner, anna, siteId, sent.id, "spam");
      expect((await approvedComments(db.runner, siteId, postId)).comments).toEqual([]);
      await moderateComment(db.runner, anna, siteId, sent.id, "restore");
      expect(await pendingCommentCount(db.runner, siteId)).toBe(1);
    });

    test("a comment is deleted for good only from the trash; turning comments off hides them", async () => {
      await saveCommentsEnabled(db.runner, anna, siteId, true);
      const sent = await addComment(db.runner, siteId, {
        entryId: postId,
        name: "Ann",
        content: "Hi",
      });
      if (!sent.ok) throw new Error("setup");
      expect(await moderateComment(db.runner, anna, siteId, sent.id, "delete")).toMatchObject({
        ok: false,
        code: "invalid",
      });
      await moderateComment(db.runner, anna, siteId, sent.id, "approve");
      await saveCommentsEnabled(db.runner, anna, siteId, false);
      expect(await approvedComments(db.runner, siteId, postId)).toEqual({
        enabled: false,
        comments: [],
      });
      await moderateComment(db.runner, anna, siteId, sent.id, "trash");
      expect(await moderateComment(db.runner, anna, siteId, sent.id, "delete")).toMatchObject({
        ok: true,
      });
      expect(await moderateComment(db.runner, anna, siteId, sent.id, "approve")).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });

    test("only a published post takes comments", async () => {
      await saveCommentsEnabled(db.runner, anna, siteId, true);
      const draft = await createDraft(db.runner, anna, siteId, { type: "post", title: "Later" });
      const page = await createDraft(db.runner, anna, siteId, { type: "page", title: "About" });
      if (!draft.ok || !page.ok) throw new Error("setup");
      for (const id of [draft.id, page.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV"])
        expect(
          await addComment(db.runner, siteId, { entryId: id, name: "Ann", content: "Hi" }),
        ).toMatchObject({
          ok: false,
          code: "not_found",
        });
    });
  });
}
