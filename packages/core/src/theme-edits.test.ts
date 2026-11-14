import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { localAdapter, type StorageAdapter } from "@oks-page/media";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import {
  discardLayoutDraft,
  getLayout,
  keepMyLayout,
  LAYOUT_HISTORY,
  layoutHash,
  listLayouts,
  listLayoutVersions,
  publishLayouts,
  resetLayout,
  restoreLayoutVersion,
  saveLayoutDraft,
} from "./theme-edits.js";
import {
  createSavedSection,
  deleteSavedSection,
  detachLinks,
  expandLinked,
  getSavedSection,
  linkProblems,
  listSavedSections,
  listSectionVersions,
  restoreSectionVersion,
  saveSectionDraft,
  SECTION_HISTORY,
  updateSavedSection,
} from "./saved-sections.js";
import {
  createOwnerLayout,
  deleteOwnerLayout,
  layoutChoices,
  loadEntryLayout,
  setEntryLayout,
  typesWithoutLayout,
} from "./owner-layouts.js";
import { installTheme, useTheme } from "./theme-install.js";
import {
  layoutCandidates,
  layoutUsage,
  loadActiveThemeLayouts,
  loadThemeLayouts,
  pickLayout,
} from "./theme-layouts.js";

function tgz(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.fill(32, 148, 156);
    h.write("0", 156);
    h.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

let counter = 0;
const block = (type: string, props: Record<string, unknown> = {}, content: unknown = null) => ({
  id: `b${++counter}`,
  type,
  props,
  content,
  children: [],
});
const text = (t: string) => block("paragraph", {}, [{ type: "text", text: t }]);
const layout = (...blocks: unknown[]) => JSON.stringify({ blocks });
/** A theme with an index layout, a single-post layout and a header; `index` changes between versions. */
const maple = (version: string, indexWords = "theme index", extra: Record<string, string> = {}) =>
  tgz({
    "theme.json": JSON.stringify({ key: "maple", name: "Maple", version }),
    "templates/index.json": layout(block("part", { name: "header" }), text(indexWords)),
    "templates/single-post.json": layout(block("part", { name: "header" }), block("post-content")),
    // The same ids in every version, as a theme author's file keeps them.
    "parts/header.json": JSON.stringify({
      title: "Header",
      blocks: [{ ...block("site-title"), id: "header-title" }],
    }),
    ...extra,
  });
const words = (nodes: unknown) => JSON.stringify(nodes);

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("the fingerprint of a layout", () => {
  test("ignores the order of keys, and changes with the content (TH-38)", () => {
    const a = [{ id: "1", type: "paragraph", props: { x: 1, y: 2 }, content: null, children: [] }];
    const b = [{ children: [], content: null, props: { y: 2, x: 1 }, type: "paragraph", id: "1" }];
    expect(layoutHash(a)).toBe(layoutHash(b));
    expect(layoutHash(a)).not.toBe(layoutHash([{ ...a[0], props: { x: 1, y: 3 } }]));
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the owner's changes to layouts`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;
    let dir = "";
    let storage: StorageAdapter;
    let themeId = "";

    const install = async (archive: Buffer) => {
      const result = await installTheme(db.runner, storage, admin, siteId, archive);
      if (!result.ok) throw new Error(result.message);
      return result.theme;
    };
    const states = async () => {
      const result = await listLayouts(db.runner, admin, siteId, themeId);
      if (!result.ok) throw new Error(result.message);
      return Object.fromEntries(
        result.layouts.map((l) => [l.key, [l.state, l.hasDraft, l.inTheme]]),
      );
    };
    const visitorIndex = async (drafts = false) =>
      words((await loadActiveThemeLayouts(db.runner, siteId, { drafts }))!.templates["index"]);

    beforeEach(async () => {
      db = await open();
      dir = await mkdtemp(path.join(tmpdir(), "oks-edits-"));
      storage = localAdapter({ root: dir, baseUrl: "/uploads" });
      const result = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, name, email, T, T],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          tagline: "Plants and pots",
          // The starter pages (Home, About, Contact) and post (Hello world), for the banner's numbers.
          starterContent: true,
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = result.siteId;
      admin = actorOf(result.userId, "administrator");
      editor = actorOf(result.userId, "editor");
      themeId = (await install(maple("1.0.0"))).id;
      await useTheme(db.runner, admin, siteId, themeId);
    });
    afterEach(async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    test("a new theme's layouts are the theme's own; only design managers may see or change them", async () => {
      expect(await states()).toEqual({
        "templates/index": ["theme", false, true],
        "templates/single-post": ["theme", false, true],
        "parts/header": ["theme", false, true],
      });
      const header = await getLayout(db.runner, admin, siteId, themeId, "parts/header");
      expect(header).toMatchObject({
        ok: true,
        layout: {
          title: "Header",
          kind: "part",
          published: null,
          draft: null,
          themeVersion: "1.0.0",
        },
      });
      for (const result of [
        await listLayouts(db.runner, editor, siteId, themeId),
        await saveLayoutDraft(db.runner, editor, siteId, themeId, "templates/index", []),
        await publishLayouts(db.runner, editor, siteId, themeId),
        await resetLayout(db.runner, editor, siteId, themeId, "templates/index"),
      ])
        expect(result).toMatchObject({ ok: false, code: "forbidden" });
      expect(await getLayout(db.runner, admin, siteId, themeId, "templates/nope")).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(await getLayout(db.runner, admin, siteId, newId(), "templates/index")).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });

    test("a draft is not shown to visitors; publish shows every changed layout at once and keeps a version", async () => {
      const draft = await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/index", [
        block("part", { name: "header" }),
        text("my index"),
      ]);
      expect(draft).toMatchObject({
        ok: true,
        layout: { state: "theme", hasDraft: true },
        repairs: 0,
      });
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "parts/header", [
        block("site-title"),
        text("my header"),
      ]);
      expect(await visitorIndex()).toContain("theme index");
      expect(await visitorIndex(true)).toContain("my index");

      const published = await publishLayouts(db.runner, admin, siteId, themeId);
      expect(published).toEqual({
        ok: true,
        published: ["parts/header", "templates/index"].sort(),
        sections: [],
      });
      expect(await states()).toMatchObject({
        "templates/index": ["owner", false, true],
        "parts/header": ["owner", false, true],
        "templates/single-post": ["theme", false, true],
      });
      expect(await visitorIndex()).toContain("my index");
      const parts = (await loadActiveThemeLayouts(db.runner, siteId))!.parts;
      expect(words(parts["header"])).toContain("my header");

      const versions = await listLayoutVersions(
        db.runner,
        admin,
        siteId,
        themeId,
        "templates/index",
      );
      expect(versions).toMatchObject({ ok: true, versions: [{ publishedBy: "Anna" }] });
      // Nothing left to publish.
      expect(await publishLayouts(db.runner, admin, siteId, themeId)).toEqual({
        ok: true,
        published: [],
        sections: [],
      });
    });

    test("drafts are checked like page content, and together with the other layouts", async () => {
      // An unsafe link is repaired and counted.
      const repaired = await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/index", [
        block("paragraph", {}, [
          { type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "x" }] },
        ]),
      ]);
      expect(repaired).toMatchObject({ ok: true, repairs: 1 });
      expect(await visitorIndex(true)).not.toContain("javascript:");

      // A header that includes itself, a part that does not exist, and something that is not a list are refused.
      for (const [key, blocks] of [
        ["parts/header", [block("part", { name: "header" })]],
        ["templates/single-post", [block("part", { name: "sidebar" })]],
        ["templates/index", "not blocks"],
      ] as const) {
        const result = await saveLayoutDraft(db.runner, admin, siteId, themeId, key, blocks);
        expect(result, key).toMatchObject({ ok: false, code: "invalid" });
      }
      expect((await getLayout(db.runner, admin, siteId, themeId, "parts/header")).ok).toBe(true);
      expect(await states()).toMatchObject({ "parts/header": ["theme", false, true] });

      // A layout name that is not the theme's own cannot be made here.
      expect(
        await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/landing", []),
      ).toMatchObject({ ok: false, code: "not_found" });
      expect(
        await saveLayoutDraft(db.runner, admin, siteId, themeId, "../templates/index", []),
      ).toMatchObject({ ok: false, code: "not_found" });
    });

    test("a draft can be thrown away; what is published stays", async () => {
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/index", [text("one")]);
      await discardLayoutDraft(db.runner, admin, siteId, themeId, "templates/index");
      expect(await states()).toMatchObject({ "templates/index": ["theme", false, true] });
      expect(await db.run(`select * from "theme_overrides"`)).toEqual([]);

      await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/index", [text("one")]);
      await publishLayouts(db.runner, admin, siteId, themeId);
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/index", [text("two")]);
      await discardLayoutDraft(db.runner, admin, siteId, themeId, "templates/index");
      expect(await states()).toMatchObject({ "templates/index": ["owner", false, true] });
      expect(await visitorIndex(true)).toContain("one");
    });

    test("history keeps the newest 20 versions; restoring one makes a draft", async () => {
      for (let i = 1; i <= LAYOUT_HISTORY + 2; i++) {
        await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/index", [
          text(`v${i}`),
        ]);
        await publishLayouts(db.runner, admin, siteId, themeId, T.getTime() + i * 1000);
      }
      const history = await listLayoutVersions(
        db.runner,
        admin,
        siteId,
        themeId,
        "templates/index",
      );
      if (!history.ok) throw new Error(history.message);
      expect(history.versions).toHaveLength(LAYOUT_HISTORY);
      expect(history.versions[0]!.publishedAt).toBe(T.getTime() + (LAYOUT_HISTORY + 2) * 1000);
      const oldest = history.versions.at(-1)!;
      expect(oldest.publishedAt).toBe(T.getTime() + 3000);

      const restored = await restoreLayoutVersion(db.runner, admin, siteId, themeId, oldest.id);
      expect(restored).toMatchObject({ ok: true, layout: { hasDraft: true } });
      expect(await visitorIndex()).toContain("v22");
      expect(await visitorIndex(true)).toContain("v3");
      expect(await restoreLayoutVersion(db.runner, admin, siteId, themeId, newId())).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });

    test("a theme update keeps the owner's changes and marks the ones it changed; keep mine and reset (TH-40, TH-53)", async () => {
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/index", [
        text("my index"),
      ]);
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "parts/header", [text("my header")]);
      await publishLayouts(db.runner, admin, siteId, themeId);

      // 1.1.0 changes index and keeps the header as it was.
      await install(maple("1.1.0", "new theme index"));
      const after = await states();
      expect(after["templates/index"]).toEqual(["owner-outdated", false, true]);
      expect(after["parts/header"]).toEqual(["owner", false, true]);
      // The visitor still sees the owner's change.
      expect(await visitorIndex()).toContain("my index");

      // Compare: both are there to show side by side.
      const compare = await getLayout(db.runner, admin, siteId, themeId, "templates/index");
      if (!compare.ok) throw new Error(compare.message);
      expect(words(compare.layout.theme)).toContain("new theme index");
      expect(words(compare.layout.published)).toContain("my index");
      expect(compare.layout).toMatchObject({ baseVersion: "1.0.0", themeVersion: "1.1.0" });

      // Keep mine: still the owner's, no longer outdated.
      expect(
        await keepMyLayout(db.runner, admin, siteId, themeId, "templates/index"),
      ).toMatchObject({
        ok: true,
        layout: { state: "owner" },
      });
      // Reset (use the theme's): the theme's layout is used again; the history stays.
      expect(await resetLayout(db.runner, admin, siteId, themeId, "templates/index")).toEqual({
        ok: true,
      });
      expect((await states())["templates/index"]).toEqual(["theme", false, true]);
      expect(await visitorIndex()).toContain("new theme index");
      const history = await listLayoutVersions(
        db.runner,
        admin,
        siteId,
        themeId,
        "templates/index",
      );
      expect(history.ok && history.versions.length).toBe(1);
    });

    test("a layout the owner changed stays listed when an update removes it from the theme", async () => {
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/single-post", [
        block("post-title"),
        block("post-content"),
      ]);
      await publishLayouts(db.runner, admin, siteId, themeId);
      await install(
        tgz({
          "theme.json": JSON.stringify({ key: "maple", name: "Maple", version: "2.0.0" }),
          "templates/index.json": layout(text("index")),
        }),
      );
      expect((await states())["templates/single-post"]).toEqual(["owner", false, false]);
      // It is still drawn for posts.
      const layouts = await loadActiveThemeLayouts(db.runner, siteId);
      expect(Object.keys(layouts!.templates).sort()).toEqual(["index", "single-post"]);
    });

    test("the banner's numbers: how many published pages and posts a layout or a header reaches", async () => {
      const layouts = (await loadActiveThemeLayouts(db.runner, siteId))!;
      // The new site has Home, About and Contact (pages) and Hello world (a post), all published.
      const index = await layoutUsage(db.runner, siteId, layouts, "templates/index");
      expect(index).toEqual({ entries: { page: 3 }, archives: true, search: true, inLayouts: [] });
      const post = await layoutUsage(db.runner, siteId, layouts, "templates/single-post");
      expect(post).toEqual({ entries: { post: 1 }, archives: false, search: false, inLayouts: [] });
      const header = await layoutUsage(db.runner, siteId, layouts, "parts/header");
      expect(header.entries).toEqual({ page: 3, post: 1 });
      expect(header.inLayouts.sort()).toEqual(["index", "single-post"]);
    });

    // ----- saved sections (spec 05, 17.6 and 17.10)
    const linked = (id: string, props: Record<string, unknown> = {}) =>
      block("linked-section", { id, ...props });
    const save = async (name: string, blocks: unknown[], group = "contact") => {
      const made = await createSavedSection(db.runner, admin, siteId, { name, group, blocks });
      if (!made.ok) throw new Error(made.message);
      return made.section.id;
    };

    test("a saved section belongs to the site: named, grouped, only for design managers, and kept across a theme switch (TH-71)", async () => {
      const id = await save("Opening hours", [text("Open every day but Monday")]);
      expect(await listSavedSections(db.runner, admin, siteId)).toMatchObject({
        ok: true,
        sections: [{ id, name: "Opening hours", group: "contact", hasDraft: false }],
      });
      expect(await listSavedSections(db.runner, editor, siteId)).toMatchObject({
        code: "forbidden",
      });
      expect(
        await createSavedSection(db.runner, editor, siteId, { name: "X", blocks: [text("x")] }),
      ).toMatchObject({ code: "forbidden" });
      expect(await saveSectionDraft(db.runner, editor, siteId, id, [text("x")])).toMatchObject({
        code: "forbidden",
      });
      // Names: required, short, new (whatever the case); a section is never empty.
      for (const [name, blocks, message] of [
        ["  ", [text("x")], /a name of 1 to 80/],
        ["x".repeat(81), [text("x")], /a name of 1 to 80/],
        ["opening HOURS", [text("x")], /already a saved section called "opening HOURS"/],
        ["Empty", [], /at least one block/],
      ] as const)
        expect(
          await createSavedSection(db.runner, admin, siteId, { name, blocks: [...blocks] }),
        ).toMatchObject({ ok: false, message: expect.stringMatching(message) });
      expect(
        await updateSavedSection(db.runner, admin, siteId, id, {
          name: "Hours",
          group: "nonsense",
        }),
      ).toMatchObject({ ok: true, section: { name: "Hours", group: "other" } });

      // A switch to another theme and back: the saved section is still there.
      const other = await install(
        tgz({
          "theme.json": JSON.stringify({ key: "birch", name: "Birch", version: "1.0.0" }),
          "templates/index.json": layout(text("birch")),
        }),
      );
      await useTheme(db.runner, admin, siteId, other.id);
      await useTheme(db.runner, admin, siteId, themeId);
      expect(await getSavedSection(db.runner, admin, siteId, id)).toMatchObject({
        ok: true,
        section: { name: "Hours", published: [{ type: "paragraph" }] },
      });
    });

    test("a copy does not follow later changes; a linked section shows the same everywhere and changes on Publish (TH-71, TH-75)", async () => {
      const id = await save("Opening hours", [text("Open every day but Monday")]);
      const saved = (await getSavedSection(db.runner, admin, siteId, id)) as {
        section: { published: { id: string }[] };
      };
      // The index places a copy; the header links it.
      const copy = { ...saved.section.published[0]!, id: "copy-1" };
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/index", [
        block("part", { name: "header" }),
        copy,
      ]);
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "parts/header", [
        block("site-title"),
        linked(id),
      ]);
      expect(await publishLayouts(db.runner, admin, siteId, themeId)).toMatchObject({
        ok: true,
        sections: [],
      });
      const drawn = async (drafts = false) => {
        const l = (await loadActiveThemeLayouts(db.runner, siteId, { drafts }))!;
        return { index: words(l.templates["index"]), header: words(l.parts["header"]) };
      };
      expect((await drawn()).index).toContain("Open every day but Monday");
      expect((await drawn()).header).toContain("Open every day but Monday");

      // A change is a draft: not on the site until Publish; then every linked place has it, the copy does not.
      await saveSectionDraft(db.runner, admin, siteId, id, [text("Open from Tuesday")]);
      expect((await drawn()).header).toContain("Open every day but Monday");
      expect((await drawn(true)).header).toContain("Open from Tuesday");
      expect(await publishLayouts(db.runner, admin, siteId, themeId)).toEqual({
        ok: true,
        published: [],
        sections: [id],
      });
      expect((await drawn()).header).toContain("Open from Tuesday");
      expect((await drawn()).index).toContain("Open every day but Monday");
      expect((await drawn()).index).not.toContain("Open from Tuesday");

      // The banner's numbers: the header (with the link) is on the index and the post layout.
      const split = (await loadThemeLayouts(db.runner, siteId, { split: true, drafts: true }))!;
      const usage = await layoutUsage(db.runner, siteId, split, `sections/${id}`);
      expect(usage.entries).toEqual({ page: 3, post: 1 });
      expect(usage.inLayouts.sort()).toEqual(["index", "single-post"]);
      // Where it is placed, for the editor and for deleting.
      expect((await getSavedSection(db.runner, admin, siteId, id)) as unknown).toMatchObject({
        places: [{ themeId, key: "parts/header" }],
      });
    });

    test("a link to a section that does not exist is refused; a section cannot hold itself (TH-79)", async () => {
      expect(
        await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/index", [
          linked("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        ]),
      ).toMatchObject({ ok: false, message: expect.stringMatching(/no longer exists/) });
      const a = await save("A", [text("a")]);
      const b = await save("B", [text("b"), linked(a)]);
      // Directly, and through another section.
      expect(await saveSectionDraft(db.runner, admin, siteId, a, [linked(a)])).toMatchObject({
        ok: false,
        message: expect.stringMatching(/"A" contains itself/),
      });
      expect(await saveSectionDraft(db.runner, admin, siteId, a, [linked(b)])).toMatchObject({
        ok: false,
        message: expect.stringMatching(
          /contains itself, directly or through another linked section/,
        ),
      });
      // A linked section inside another is drawn inside it.
      const sections = new Map([
        [a, [text("a")]],
        [b, [text("b"), linked(a)]],
      ]);
      expect(words(expandLinked([linked(b)], sections))).toMatch(/"b".*"a"/);
      // Seven levels deep is too deep.
      const chain = new Map<string, { name: string; blocks: ReturnType<typeof text>[] }>();
      for (let i = 0; i < 8; i++)
        chain.set(`s${i}`, {
          name: `s${i}`,
          blocks: i < 7 ? [linked(`s${i + 1}`)] : [text("end")],
        });
      expect(linkProblems(chain).join(" ")).toMatch(/"s0" links sections more than 6 levels deep/);
    });

    test("hiding set on the link is given to each block in its place, as on a copy", () => {
      const sections = new Map([
        ["x", [text("one"), { ...text("two"), props: { hide: ["tablet"] } }]],
      ]);
      const expanded = expandLinked([linked("x", { hide: ["phone"] })], sections);
      expect(expanded.map((b) => b.props["hide"])).toEqual([["phone"], ["tablet", "phone"]]);
      const detached = detachLinks([linked("x", { hide: ["phone"] })], "x", sections.get("x")!);
      expect(detached.map((b) => b.props["hide"])).toEqual([["phone"], ["tablet", "phone"]]);
      expect(detached.map((b) => b.id)).not.toContain(sections.get("x")![0]!.id);
    });

    test("deleting a linked section turns every placement into a copy first: the pages look the same (TH-78)", async () => {
      const id = await save("Opening hours", [text("Open every day but Monday")]);
      const holder = await save("Contact box", [text("Call us"), linked(id)]);
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "parts/header", [
        block("site-title"),
        linked(id, { hide: ["phone"] }),
      ]);
      await publishLayouts(db.runner, admin, siteId, themeId);
      // A draft that links it too.
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/index", [
        block("part", { name: "header" }),
        linked(holder),
      ]);
      const before = (await loadActiveThemeLayouts(db.runner, siteId, { drafts: true }))!;
      const beforePublic = (await loadActiveThemeLayouts(db.runner, siteId))!;

      expect(await deleteSavedSection(db.runner, editor, siteId, id)).toMatchObject({
        code: "forbidden",
      });
      const deleted = await deleteSavedSection(db.runner, admin, siteId, id);
      expect(deleted).toMatchObject({ ok: true });
      expect((deleted as { copied: { key: string }[] }).copied.map((p) => p.key).sort()).toEqual([
        "parts/header",
        `sections/${holder}`,
      ]);
      expect(await getSavedSection(db.runner, admin, siteId, id)).toMatchObject({
        code: "not_found",
      });
      // Every page draws the same, published and draft.
      expect(words(await loadActiveThemeLayouts(db.runner, siteId, { drafts: true }))).toBe(
        words(before),
      );
      expect(words(await loadActiveThemeLayouts(db.runner, siteId))).toBe(words(beforePublic));
      // The drafts can still be published (no link to a missing section is left behind).
      expect(await publishLayouts(db.runner, admin, siteId, themeId)).toMatchObject({ ok: true });
      const audit = await db.run(
        "select action, target_id, detail from audit_log where action = 'saved_section.delete'",
      );
      expect(audit).toHaveLength(1);
      const detail = audit[0]!["detail"];
      expect(typeof detail === "string" ? detail : JSON.stringify(detail)).toContain(
        "Opening hours",
      );
    });

    test("history keeps the newest 20 published versions of a saved section; restoring one makes a draft", async () => {
      // Made at the start of the history, so the versions are in the order they were published.
      const made = await createSavedSection(
        db.runner,
        admin,
        siteId,
        { name: "Notice", blocks: [text("v0")] },
        T.getTime(),
      );
      if (!made.ok) throw new Error(made.message);
      const id = made.section.id;
      for (let i = 1; i <= SECTION_HISTORY + 2; i++) {
        await saveSectionDraft(db.runner, admin, siteId, id, [text(`v${i}`)]);
        await publishLayouts(db.runner, admin, siteId, themeId, T.getTime() + i * 1000);
      }
      const versions = await listSectionVersions(db.runner, admin, siteId, id);
      if (!versions.ok) throw new Error(versions.message);
      expect(versions.versions).toHaveLength(SECTION_HISTORY);
      const oldest = versions.versions.at(-1)!;
      expect(await restoreSectionVersion(db.runner, admin, siteId, oldest.id)).toMatchObject({
        ok: true,
        section: { hasDraft: true },
      });
      expect(words(await getSavedSection(db.runner, admin, siteId, id))).toContain('"v3"');
    });

    // ----- layouts the owner makes (spec 05, 17.6; TH-72)
    const entryId = async (slug: string) =>
      String((await db.run("select id from entries where slug = ?", [slug]))[0]!["id"]);
    const drawnFor = async (slug: string, type: string, chosen = "") => {
      const layouts = (await loadActiveThemeLayouts(db.runner, siteId))!;
      return words(pickLayout(layouts, layoutCandidates({ kind: "entry", type, slug, chosen })));
    };

    test("a named layout: made from another, chosen by a page, never touched by a theme update, deleted with its pages moved back (TH-72)", async () => {
      expect(
        await createOwnerLayout(db.runner, editor, siteId, themeId, { for: "pages", name: "X" }),
      ).toMatchObject({ code: "forbidden" });
      for (const [name, message] of [["", /a name of 1 to 60/]] as const)
        expect(
          await createOwnerLayout(db.runner, admin, siteId, themeId, { for: "pages", name }),
        ).toMatchObject({ ok: false, message: expect.stringMatching(message) });
      const made = await createOwnerLayout(db.runner, admin, siteId, themeId, {
        for: "pages",
        name: "Landing page",
        from: "templates/index",
      });
      expect(made).toMatchObject({
        ok: true,
        layout: {
          key: "templates/custom-landing-page",
          title: "Landing page",
          state: "owner-made",
        },
      });
      // The same name again (whatever the case) is refused; a second named layout gets its own address.
      expect(
        await createOwnerLayout(db.runner, admin, siteId, themeId, {
          for: "pages",
          name: "landing PAGE",
        }),
      ).toMatchObject({ ok: false });
      expect(await states()).toMatchObject({
        "templates/custom-landing-page": ["owner-made", false, false],
      });
      // It starts as a copy of the index, published; change it like any layout.
      await saveLayoutDraft(db.runner, admin, siteId, themeId, "templates/custom-landing-page", [
        text("big landing"),
      ]);
      await publishLayouts(db.runner, admin, siteId, themeId);
      expect(await layoutChoices(db.runner, siteId)).toEqual([
        { name: "custom-landing-page", title: "Landing page" },
      ]);

      // A page chooses it; only layouts of the theme in use can be chosen; only people who may edit the page.
      const about = await entryId("about");
      expect(await setEntryLayout(db.runner, admin, siteId, about, "custom-nothing")).toMatchObject(
        {
          ok: false,
          message: expect.stringMatching(/not one of the theme in use/),
        },
      );
      expect(
        await setEntryLayout(db.runner, admin, siteId, about, "custom-landing-page"),
      ).toMatchObject({ ok: true, layout: "custom-landing-page" });
      expect(await loadEntryLayout(db.runner, admin, siteId, about)).toMatchObject({
        ok: true,
        layout: "custom-landing-page",
        choices: [{ title: "Landing page" }],
      });
      expect(await drawnFor("about", "page", "custom-landing-page")).toContain("big landing");
      // The banner counts the page that chose it.
      const usage = await layoutUsage(
        db.runner,
        siteId,
        (await loadActiveThemeLayouts(db.runner, siteId))!,
        "templates/custom-landing-page",
      );
      expect(usage.entries).toEqual({ page: 1 });

      // A theme update keeps it as it is.
      await install(maple("1.1.0", "new theme index"));
      expect(await states()).toMatchObject({
        "templates/custom-landing-page": ["owner-made", false, false],
      });
      expect(await drawnFor("about", "page", "custom-landing-page")).toContain("big landing");
      // Another theme has no such layout: the page uses that theme's usual layout; switching back brings it back.
      const other = await install(
        tgz({
          "theme.json": JSON.stringify({ key: "birch", name: "Birch", version: "1.0.0" }),
          "templates/index.json": layout(text("birch")),
        }),
      );
      await useTheme(db.runner, admin, siteId, other.id);
      expect(await drawnFor("about", "page", "custom-landing-page")).toContain("birch");
      await useTheme(db.runner, admin, siteId, themeId);
      expect(await drawnFor("about", "page", "custom-landing-page")).toContain("big landing");

      // Theme layouts cannot be deleted; this one can, and the page goes back to its usual layout.
      expect(
        await deleteOwnerLayout(db.runner, admin, siteId, themeId, "templates/index"),
      ).toMatchObject({ ok: false, message: expect.stringMatching(/can be reset instead/) });
      const deleted = await deleteOwnerLayout(
        db.runner,
        admin,
        siteId,
        themeId,
        "templates/custom-landing-page",
      );
      expect(deleted).toMatchObject({ ok: true, moved: [{ slug: "about", title: "About" }] });
      expect(await loadEntryLayout(db.runner, admin, siteId, about)).toMatchObject({
        layout: "",
        choices: [],
      });
      expect(await states()).not.toHaveProperty("templates/custom-landing-page");
      expect(
        await db.run("select action from audit_log where action = 'layout.delete'"),
      ).toHaveLength(1);
    });

    test("a layout for a content type that has none: its entries use it at once; a type that has one is refused", async () => {
      await db.run(
        `insert into content_types (id, site_id, key, label, url_rule, has_body, hierarchical, options, created_at, updated_at)
          values (?, ?, 'recipe', 'Recipe', '/recipes/{slug}', ?, ?, '{}', ?, ?)`,
        [newId(), siteId, true, false, T, T],
      );
      expect(
        (await typesWithoutLayout(db.runner, siteId, themeId)).map((t) => t.key).sort(),
      ).toEqual(["page", "recipe"]);
      expect(
        await createOwnerLayout(db.runner, admin, siteId, themeId, { for: "post", from: "blank" }),
      ).toMatchObject({
        ok: false,
        message: expect.stringMatching(/already has a layout of its own/),
      });
      expect(
        await createOwnerLayout(db.runner, admin, siteId, themeId, { for: "nonsense" }),
      ).toMatchObject({ ok: false, message: "Choose a content type of this site." });
      const made = await createOwnerLayout(db.runner, admin, siteId, themeId, {
        for: "recipe",
        from: "blank",
      });
      expect(made).toMatchObject({
        ok: true,
        layout: { key: "templates/single-recipe", title: "Recipe", state: "owner-made" },
      });
      // Blank: the page's title and content only, used by recipes (and not by posts).
      const recipe = await drawnFor("recipes/soup", "recipe");
      expect(recipe).toContain("post-title");
      expect(recipe).not.toContain("header");
      expect(await drawnFor("blog/hello-world", "post")).toContain("header");
      expect((await typesWithoutLayout(db.runner, siteId, themeId)).map((t) => t.key)).toEqual([
        "page",
      ]);
    });
  });
}
