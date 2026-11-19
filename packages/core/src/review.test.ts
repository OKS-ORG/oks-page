// The review workflow: a writer who may not publish hands an entry to an editor ("waiting for review"); only
// someone who may publish takes it live. On SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, loadForEdit, saveContent, type Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: waiting for review`, () => {
    let db: TestDb;
    let siteId = "";
    let editor: Actor;
    let writer: Actor;

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
      editor = actorOf(setup.userId, "editor");
      const wid = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [wid, "Wim", "wim@example.com", T, T],
      );
      writer = actorOf(wid, "contributor");
    });
    afterEach(async () => db.close());

    const save = (who: Actor, id: string, status: string, revision: number) =>
      saveContent(db.runner, who, siteId, id, {
        title: "Idea",
        slugPart: "idea",
        status,
        blocks: [],
        revision,
      });

    test("a contributor hands a post over; they cannot publish it; an editor can", async () => {
      const made = await createDraft(db.runner, writer, siteId, { type: "post", title: "Idea" });
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      const sent = await save(writer, made.id, "pending", 1);
      expect(sent).toMatchObject({ ok: true, status: "pending" });
      const loaded = await loadForEdit(db.runner, writer, siteId, made.id);
      expect(loaded.ok && loaded.entry.status).toBe("pending");
      // Still not public, and a contributor cannot take it live.
      expect(await save(writer, made.id, "published", sent.ok ? sent.revision : 0)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      const row = (await db.runner.all(`select status from entries where id = ?`, [made.id]))[0]!;
      expect(row["status"]).toBe("pending");
      // An editor sees it and publishes it.
      const live = await save(editor, made.id, "published", sent.ok ? sent.revision : 0);
      expect(live).toMatchObject({ ok: true, status: "published" });
    });

    test("an unknown status is still refused", async () => {
      const made = await createDraft(db.runner, writer, siteId, { type: "post", title: "Idea" });
      if (!made.ok) throw new Error("setup");
      expect(await save(writer, made.id, "private", 1)).toMatchObject({
        ok: false,
        code: "invalid",
      });
    });
  });
}
