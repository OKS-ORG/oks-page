// The plugins' hooks in a save (spec 04, sections 5.3 and 7), with fake hooks: what the core does with their answers. On
// SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, saveContent, type Actor, type HookEntry, type SaveHooks } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: plugin hooks in a save`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let entryId = "";

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
      const made = await createDraft(db.runner, anna, siteId, { type: "post", title: "First" });
      if (!made.ok) throw new Error("no draft");
      entryId = made.id;
    });
    afterEach(async () => {
      await db.close();
    });

    const save = (status: string, revision: number, hooks?: SaveHooks, title = "First") =>
      saveContent(
        db.runner,
        anna,
        siteId,
        entryId,
        { title, slugPart: "first", status, blocks: [], revision },
        undefined,
        hooks ? { hooks } : {},
      );
    const stored = async () => {
      const row = (
        await db.run("select title, meta, status from entries where id = ?", [entryId])
      )[0]!;
      const meta = typeof row["meta"] === "string" ? JSON.parse(row["meta"]) : row["meta"];
      return { title: String(row["title"]), status: String(row["status"]), meta };
    };

    test("a refusal before going live stops it with the plugin's words, and nothing is saved", async () => {
      const seen: HookEntry[] = [];
      const hooks: SaveHooks = {
        beforePublish: async (e) => {
          seen.push(e);
          return { allowed: false, message: "Add a featured image first" };
        },
      };
      const r = await save("published", 1, hooks);
      expect(r).toMatchObject({
        ok: false,
        code: "invalid",
        field: "status",
        message: "Add a featured image first",
      });
      expect(seen[0]).toMatchObject({
        id: entryId,
        status: "published",
        title: "First",
        typeKey: "post",
      });
      expect((await stored()).status).toBe("draft");
    });

    test("the check runs when an entry goes live, not for a draft or for a page that is already live", async () => {
      let calls = 0;
      const hooks: SaveHooks = {
        beforePublish: async () => {
          calls++;
          return { allowed: true };
        },
      };
      expect(await save("draft", 1, hooks)).toMatchObject({ ok: true });
      expect(await save("pending", 2, hooks)).toMatchObject({ ok: true });
      expect(calls).toBe(0);
      expect(await save("published", 3, hooks)).toMatchObject({ ok: true });
      expect(calls).toBe(1);
      expect(await save("published", 4, hooks)).toMatchObject({ ok: true });
      expect(calls).toBe(1);
    });

    test("a filter before the save may change the title and add values under the plugin's own name", async () => {
      const hooks: SaveHooks = {
        beforeSave: async () => ({
          title: "  First, improved  ",
          plugins: { "reading-time": { minutes: 3 } },
        }),
      };
      expect(await save("draft", 1, hooks)).toMatchObject({ ok: true });
      const row = await stored();
      expect(row.title).toBe("First, improved");
      expect(row.meta).toMatchObject({ plugins: { "reading-time": { minutes: 3 } } });
      // A second plugin's part sits beside the first one, and the first one is kept.
      await save(
        "draft",
        2,
        { beforeSave: async () => ({ plugins: { other: { n: 1 } } }) },
        "First, improved",
      );
      expect((await stored()).meta.plugins).toEqual({
        "reading-time": { minutes: 3 },
        other: { n: 1 },
      });
    });

    test("a title that is empty or too long, and a part that is too big, are left out", async () => {
      const hooks: SaveHooks = {
        beforeSave: async () => ({
          title: "x".repeat(201),
          plugins: { big: { text: "y".repeat(5000) }, ok: { n: 1 } },
        }),
      };
      expect(await save("draft", 1, hooks)).toMatchObject({ ok: true });
      const row = await stored();
      expect(row.title).toBe("First");
      expect(row.meta.plugins).toEqual({ ok: { n: 1 } });
      await save("draft", 2, { beforeSave: async () => ({ title: "   " }) });
      expect((await stored()).title).toBe("First");
    });

    test("an action after the save gets the saved entry, and one that throws changes nothing", async () => {
      let got: HookEntry | undefined;
      expect(
        await save("draft", 1, {
          afterSave: (e) => {
            got = e;
          },
        }),
      ).toMatchObject({ ok: true });
      expect(got).toMatchObject({ id: entryId, title: "First", status: "draft" });
      expect(
        await save("draft", 2, {
          afterSave: () => {
            throw new Error("late");
          },
        }),
      ).toMatchObject({ ok: true });
    });

    test("with no hooks the save is as it always was", async () => {
      expect(await save("published", 1)).toMatchObject({ ok: true, status: "published" });
      expect((await stored()).meta.plugins).toBeUndefined();
    });
  });
}
