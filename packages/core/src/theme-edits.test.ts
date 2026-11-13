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
import { installTheme, useTheme } from "./theme-install.js";
import { loadActiveThemeLayouts } from "./theme-layouts.js";

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
  });
}
