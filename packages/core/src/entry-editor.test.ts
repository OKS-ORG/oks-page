// The layout editor's rules on the server: which editor opens, switching (PB-80 to PB-84), and locked parts (PB-30 to
// PB-33, PB-62). On SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, loadForEdit, saveContent, type Actor } from "./content.js";
import { editorSwitchCost, switchEditor } from "./entry-editor.js";
import { listRevisions } from "./revisions.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const words = (value: string) => [{ type: "text", text: value, styles: {} }];
const para = (value: string, id = newId(), props: Record<string, unknown> = {}) => ({
  id,
  type: "paragraph",
  props,
  content: words(value),
  children: [],
});
const section = (children: unknown[], props: Record<string, unknown> = {}) => ({
  id: newId(),
  type: "section",
  props,
  content: null,
  children,
});

const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the layout editor on the server`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor; // administrator: a designer
    let eve: Actor; // editor: a client

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
      const eveId = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [eveId, "Eve", "eve@example.com", T, T],
      );
      eve = actorOf(eveId, "editor");
    });
    afterEach(async () => db.close());

    /** A page holding these blocks, saved by the designer. */
    async function page(blocks: unknown[], title = "P") {
      const made = await createDraft(db.runner, anna, siteId, { type: "page", title });
      if (!made.ok) throw new Error(made.message);
      const saved = await saveContent(db.runner, anna, siteId, made.id, {
        title,
        slugPart: made.slug,
        status: "draft",
        blocks,
        revision: made.revision,
      });
      if (!saved.ok) throw new Error(saved.message);
      return { id: made.id, slug: made.slug, revision: saved.revision };
    }
    const revisionsOf = async (id: string) => {
      const listed = await listRevisions(db.runner, anna, siteId, id);
      if (!listed.ok) throw new Error(listed.message);
      return listed.revisions;
    };
    const blocksOf = async (id: string) => {
      const loaded = await loadForEdit(db.runner, anna, siteId, id);
      if (!loaded.ok) throw new Error(loaded.message);
      return loaded.entry;
    };

    test("PB-83: a page made the old way opens in the writing editor, and one with layout blocks in the layout editor", async () => {
      const old = await page([para("hello")]);
      expect((await blocksOf(old.id)).editor).toBe("writing");
      const laid = await page([section([para("hi")])]);
      expect((await blocksOf(laid.id)).editor).toBe("layout");
    });

    test("PB-80: the screen that adds an entry chooses the editor; without a choice it is the writing editor", async () => {
      const make = async (input: { type: string; editor?: "writing" | "layout" }) => {
        const made = await createDraft(db.runner, anna, siteId, { title: "New one", ...input });
        if (!made.ok) throw new Error(made.message);
        return (await blocksOf(made.id)).editor;
      };
      expect(await make({ type: "page", editor: "layout" })).toBe("layout");
      expect(await make({ type: "page", editor: "writing" })).toBe("writing");
      expect(await make({ type: "page" })).toBe("writing");
      expect(await make({ type: "post" })).toBe("writing");
    });

    test("PB-81: writing to layout keeps every block, its order and its text, and saves a revision first", async () => {
      const made = await page([para("one"), para("two"), para("three")]);
      const before = await revisionsOf(made.id);
      const result = await switchEditor(db.runner, anna, siteId, made.id, "layout");
      expect(result).toMatchObject({ ok: true });
      const entry = await blocksOf(made.id);
      expect(entry.editor).toBe("layout");
      const texts = (list: { content: unknown; children: unknown[] }[]): string[] =>
        list.flatMap((b) => [
          ...(Array.isArray(b.content) ? [String((b.content[0] as { text: string }).text)] : []),
          ...texts(b.children as never),
        ]);
      expect(texts(entry.blocks as never)).toEqual(["one", "two", "three"]);
      // loose blocks went into one section: the top of the page is all sections
      expect(entry.blocks.every((b) => b.type === "section")).toBe(true);
      const after = await revisionsOf(made.id);
      // The state before the switch is already a revision (the save that made it), and the switch adds its own.
      expect(after.length).toBeGreaterThanOrEqual(before.length + 1);
      expect(after.some((r) => r.summary.includes("Switched to the layout editor"))).toBe(true);
    });

    test("PB-82: layout to writing is allowed for a flow-only body; otherwise it lists what would be lost and waits", async () => {
      const flow = await page([section([para("a"), para("b")])]);
      expect(await editorSwitchCost(db.runner, anna, siteId, flow.id)).toMatchObject({
        ok: true,
        lost: [],
      });
      expect((await switchEditor(db.runner, anna, siteId, flow.id, "writing")).ok).toBe(true);
      const plain = await blocksOf(flow.id);
      expect(plain.editor).toBe("writing");
      expect(plain.blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);

      const styled = await page([
        section([
          {
            id: newId(),
            type: "columns",
            props: {},
            content: null,
            children: [
              { id: newId(), type: "column", props: {}, content: null, children: [para("L")] },
              { id: newId(), type: "column", props: {}, content: null, children: [para("R")] },
            ],
          },
          { id: newId(), type: "spacer", props: { size: "lg" }, content: null, children: [] },
          para("x", newId(), { style: { base: { gap: "8px" } } }),
        ]),
      ]);
      const refused = await switchEditor(db.runner, anna, siteId, styled.id, "writing");
      expect(refused).toMatchObject({ ok: false, code: "would_lose" });
      const lost = !refused.ok ? (refused.lost ?? []) : [];
      expect(lost.join(" ")).toContain("columns");
      expect(lost.join(" ")).toContain("spacer");
      expect(lost.join(" ")).toContain("spacing, colours and sizes");
      // nothing changed yet
      expect((await blocksOf(styled.id)).editor).toBe("layout");
      const revisionsBefore = (await revisionsOf(styled.id)).length;
      const done = await switchEditor(db.runner, anna, siteId, styled.id, "writing", {
        anyway: true,
      });
      expect(done.ok).toBe(true);
      const flat = await blocksOf(styled.id);
      expect(flat.editor).toBe("writing");
      expect(flat.blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
      // the old state is in the revisions
      const revisions = await revisionsOf(styled.id);
      expect(revisions.length).toBeGreaterThanOrEqual(revisionsBefore + 2);
    });

    test("PB-30 to PB-33, PB-62, PB-84: a client cannot change, move, remove or unlock a locked part, nor switch the editor; a designer can", async () => {
      const lockedId = newId();
      const textLockedId = newId();
      const made = await page([
        section([
          para("locked words", lockedId, { locked: true }),
          para("editable words", textLockedId, { locked: true, lockMode: "content" }),
          para("free"),
        ]),
      ]);
      const entry = await blocksOf(made.id);
      const same = {
        title: "P",
        slugPart: made.slug,
        status: "draft",
        revision: entry.revision,
      };
      const edit = (change: (blocks: typeof entry.blocks) => unknown) =>
        saveContent(db.runner, eve, siteId, made.id, {
          ...same,
          blocks: change(JSON.parse(JSON.stringify(entry.blocks))),
        });
      const find = (blocks: typeof entry.blocks, id: string) =>
        blocks[0]!.children.find((b) => b.id === id)!;
      const refusal = {
        ok: false,
        code: "forbidden",
        message: "This part is locked by your designer.",
      };

      // words of a fully locked block
      expect(
        await edit((b) => {
          find(b, lockedId).content = words("changed");
          return b;
        }),
      ).toMatchObject(refusal);
      // its settings
      expect(
        await edit((b) => {
          find(b, lockedId).props["align"] = "end";
          return b;
        }),
      ).toMatchObject(refusal);
      // removing it
      expect(
        await edit((b) => {
          b[0]!.children = b[0]!.children.filter((c) => c.id !== lockedId);
          return b;
        }),
      ).toMatchObject(refusal);
      // moving it out of its section
      expect(
        await edit((b) => {
          const [moved] = b[0]!.children.splice(0, 1);
          return [...b, { ...b[0]!, id: newId(), children: [moved] }];
        }),
      ).toMatchObject(refusal);
      // taking the lock off, or putting a lock on
      expect(
        await edit((b) => {
          delete find(b, lockedId).props["locked"];
          return b;
        }),
      ).toMatchObject(refusal);
      expect(
        await edit((b) => {
          b[0]!.children[2]!.props["locked"] = true;
          return b;
        }),
      ).toMatchObject(refusal);
      // a new block inside a locked part, or one that arrives locked
      expect(
        await edit((b) => {
          b[0]!.children.push(para("new", newId(), { locked: true }));
          return b;
        }),
      ).toMatchObject(refusal);
      // the editor cannot be switched under a lock
      expect(await switchEditor(db.runner, eve, siteId, made.id, "writing")).toMatchObject({
        ok: false,
        code: "forbidden",
        message: "This part is locked by your designer.",
      });

      // what a client may still do: change the words of a content-locked block, and work in the free part
      const ok = await edit((b) => {
        find(b, textLockedId).content = words("new words");
        find(b, entry.blocks[0]!.children[2]!.id).content = words("free again");
        b[0]!.children.push(para("added"));
        return b;
      });
      expect(ok).toMatchObject({ ok: true });
      // but not move or restyle the content-locked block
      const second = await blocksOf(made.id);
      expect(
        await saveContent(db.runner, eve, siteId, made.id, {
          ...same,
          revision: second.revision,
          blocks: (() => {
            const b = JSON.parse(JSON.stringify(second.blocks));
            b[0].children.find((c: { id: string }) => c.id === textLockedId).props.align = "end";
            return b;
          })(),
        }),
      ).toMatchObject(refusal);

      // a designer can edit anything, and switch
      const designer = await saveContent(db.runner, anna, siteId, made.id, {
        ...same,
        revision: second.revision,
        blocks: [section([para("designer wrote this", lockedId, { locked: true })])],
      });
      expect(designer.ok).toBe(true);
    });
  });
}
