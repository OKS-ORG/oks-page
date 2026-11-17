// Scheduled publishing on SQLite and PostgreSQL (EC-39).
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, listEntries, loadForEdit, saveContent, type Actor } from "./content.js";
import { listRevisions } from "./revisions.js";
import { DEFAULT_ROLES } from "./roles.js";
import { publishDue, type MayPublish } from "./schedule.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const HOUR = 3_600_000;
const para = (value: string) => ({
  id: newId(),
  type: "paragraph",
  props: {},
  content: [{ type: "text", text: value, styles: {} }],
  children: [],
});

const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: scheduled publishing`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor; // administrator
    let bob: Actor; // author: may publish his own
    let cara: Actor; // contributor: may not publish
    const everyone: MayPublish = async () => true;

    const user = async (name: string) => {
      const id = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [id, name, `${name.toLowerCase()}@example.com`, T, T],
      );
      return id;
    };
    const draft = async (actor: Actor, title: string) => {
      const made = await createDraft(db.runner, actor, siteId, { type: "page", title });
      if (!made.ok) throw new Error(made.message);
      return made;
    };
    const schedule = (
      actor: Actor,
      id: string,
      revision: number,
      scheduledAt: string | null,
      status = "scheduled",
      now = T.getTime(),
    ) =>
      saveContent(
        db.runner,
        actor,
        siteId,
        id,
        {
          title: "T",
          slugPart: id.toLowerCase(),
          status,
          scheduledAt,
          blocks: [para("hello")],
          revision,
        },
        () => now,
      );
    const row = async (id: string) =>
      (await db.runner.all(`select * from "entries" where "id" = ?`, [id]))[0]!;
    const iso = (ms: number) => new Date(ms).toISOString();

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
      bob = actorOf(await user("Bob"), "author");
      cara = actorOf(await user("Cara"), "contributor");
    });
    afterEach(async () => db.close());

    test("saving as scheduled needs a time in the future, and the right to publish", async () => {
      const page = await draft(bob, "Later");
      const bad = async (at: string | null) =>
        schedule(bob, page.id, 1, at).then((r) => (r.ok ? "ok" : `${r.code}:${r.field}`));
      expect(await bad(null)).toBe("invalid:scheduledAt");
      expect(await bad("not a time")).toBe("invalid:scheduledAt");
      expect(await bad(iso(T.getTime() - HOUR))).toBe("invalid:scheduledAt");
      const mine = await draft(cara, "Cara's");
      expect(await schedule(cara, mine.id, 1, iso(T.getTime() + HOUR))).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      const saved = await schedule(bob, page.id, 1, iso(T.getTime() + HOUR));
      expect(saved).toMatchObject({
        ok: true,
        status: "scheduled",
        scheduledAt: iso(T.getTime() + HOUR),
      });
    });

    test("a scheduled entry is not live, shows its time in the editor, and the time goes when it is saved as a draft", async () => {
      const page = await draft(anna, "Soon");
      const saved = await schedule(anna, page.id, 1, iso(T.getTime() + HOUR));
      if (!saved.ok) throw new Error(saved.message);
      const loaded = await loadForEdit(db.runner, anna, siteId, page.id);
      expect(loaded).toMatchObject({
        ok: true,
        entry: { status: "scheduled", scheduledAt: iso(T.getTime() + HOUR) },
      });
      expect((await listEntries(db.runner, anna, siteId, "page"))[0]!.status).toBe("scheduled");
      const back = await schedule(anna, page.id, saved.revision, null, "draft");
      expect(back).toMatchObject({ ok: true, status: "draft", scheduledAt: null });
      expect((await row(page.id))["scheduled_at"]).toBeNull();
    });

    test("the job publishes what is due, once, and leaves what is not due", async () => {
      const due = await draft(anna, "Due");
      const later = await draft(anna, "Later");
      await schedule(anna, due.id, 1, iso(T.getTime() + HOUR));
      await schedule(anna, later.id, 1, iso(T.getTime() + 5 * HOUR));
      expect(await publishDue(db.runner, everyone, () => T.getTime() + 30 * 60_000)).toEqual({
        published: [],
        blocked: [],
        held: [],
      });
      const now = () => T.getTime() + 2 * HOUR;
      const run = await publishDue(db.runner, everyone, now);
      expect(run.published.map((e) => e.id)).toEqual([due.id]);
      expect(run.published[0]).toMatchObject({ siteId, type: "page", slug: due.id.toLowerCase() });
      const done = await row(due.id);
      expect(done["status"]).toBe("published");
      expect(done["scheduled_at"]).toBeNull();
      expect(done["published_at"]).not.toBeNull();
      expect((await row(later.id))["status"]).toBe("scheduled");
      // Running it again does nothing more.
      expect(await publishDue(db.runner, everyone, now)).toEqual({
        published: [],
        blocked: [],
        held: [],
      });
    });

    test("the page is checked again when the time comes: one that lost its content goes back to a draft with the reason; an administrator's set-aside is respected", async () => {
      const emptied = await draft(anna, "Emptied");
      const kept = await draft(anna, "Set aside");
      await schedule(anna, emptied.id, 1, iso(T.getTime() + HOUR));
      await saveContent(
        db.runner,
        anna,
        siteId,
        kept.id,
        {
          title: "T",
          slugPart: kept.id.toLowerCase(),
          status: "scheduled",
          scheduledAt: iso(T.getTime() + HOUR),
          blocks: [],
          revision: 1,
        },
        () => T.getTime(),
        { publishAnyway: true },
      );
      // The first one is changed after it was scheduled: its words are taken out and it is saved again.
      await saveContent(
        db.runner,
        anna,
        siteId,
        emptied.id,
        {
          title: "T",
          slugPart: emptied.id.toLowerCase(),
          status: "scheduled",
          scheduledAt: iso(T.getTime() + HOUR),
          blocks: [],
          revision: 2,
        },
        () => T.getTime(),
      );
      const run = await publishDue(db.runner, everyone, () => T.getTime() + 2 * HOUR);
      expect(run.held.map((e) => e.id)).toEqual([emptied.id]);
      expect(run.published.map((e) => e.id)).toEqual([kept.id]);
      expect(run.blocked).toEqual([]);
      const after = await row(emptied.id);
      expect(after["status"]).toBe("draft");
      expect(after["scheduled_at"]).toBeNull();
      const revisions = await listRevisions(db.runner, anna, siteId, emptied.id);
      if (!revisions.ok) throw new Error(revisions.message);
      expect(revisions.revisions[0]!.summary).toMatch(/^Not published: .*no content yet/);
      expect((await row(kept.id))["status"]).toBe("published");
    });

    test("two servers asking at once publish an entry only once", async () => {
      const page = await draft(anna, "Race");
      await schedule(anna, page.id, 1, iso(T.getTime() + HOUR));
      const now = () => T.getTime() + 2 * HOUR;
      const [a, b] = await Promise.all([
        publishDue(db.runner, everyone, now),
        publishDue(db.runner, everyone, now),
      ]);
      expect(a.published.length + b.published.length).toBe(1);
      const revisions = await listRevisions(db.runner, anna, siteId, page.id);
      if (!revisions.ok) throw new Error(revisions.message);
      expect(revisions.revisions.filter((r) => r.summary === "Published on schedule")).toHaveLength(
        1,
      );
    });

    test("it is published only if the person who scheduled it still may; otherwise it goes back to a draft", async () => {
      const page = await draft(bob, "Bob's");
      await schedule(bob, page.id, 1, iso(T.getTime() + HOUR));
      const noLongerAllowed: MayPublish = async ({ userId }) => userId !== bob.userId;
      const run = await publishDue(db.runner, noLongerAllowed, () => T.getTime() + 2 * HOUR);
      expect(run.published).toEqual([]);
      expect(run.blocked.map((e) => e.id)).toEqual([page.id]);
      const after = await row(page.id);
      expect(after["status"]).toBe("draft");
      expect(after["scheduled_at"]).toBeNull();
      const revisions = await listRevisions(db.runner, anna, siteId, page.id);
      if (!revisions.ok) throw new Error(revisions.message);
      expect(revisions.revisions[0]!.summary).toMatch(/^Not published/);
    });

    test("the publishing asks about the entry's type and author", async () => {
      const page = await draft(bob, "Asked");
      await schedule(bob, page.id, 1, iso(T.getTime() + HOUR));
      const asked: unknown[] = [];
      await publishDue(
        db.runner,
        async (who) => {
          asked.push(who);
          return true;
        },
        () => T.getTime() + 2 * HOUR,
      );
      expect(asked).toEqual([{ siteId, userId: bob.userId, type: "page", authorId: bob.userId }]);
    });

    test("the copies list says it was scheduled, and published on schedule", async () => {
      const page = await draft(anna, "Story");
      await schedule(anna, page.id, 1, iso(T.getTime() + HOUR));
      await publishDue(db.runner, everyone, () => T.getTime() + 2 * HOUR);
      const revisions = await listRevisions(db.runner, anna, siteId, page.id);
      if (!revisions.ok) throw new Error(revisions.message);
      const summaries = revisions.revisions.map((r) => r.summary);
      expect(summaries[0]).toBe("Published on schedule");
      expect(summaries[1]).toContain("scheduled it");
    });
  });
}
