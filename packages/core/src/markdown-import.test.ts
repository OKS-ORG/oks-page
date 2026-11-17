import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  frontMatter,
  importPagesFromMarkdown,
  inlineRuns,
  markdownToBlocks,
  MAX_MARKDOWN_FILE_CHARS,
  MAX_MARKDOWN_FILES,
} from "./markdown-import.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("reading Markdown", () => {
  test("inside text: bold, italic, code and links; everything else stays as written", () => {
    expect(
      inlineRuns(
        "Hello **bold** and *it* and __b2__ and _i2_ and `code` and [link](https://example.org) end",
      ),
    ).toEqual([
      { type: "text", text: "Hello ", styles: {} },
      { type: "text", text: "bold", styles: { bold: true } },
      { type: "text", text: " and ", styles: {} },
      { type: "text", text: "it", styles: { italic: true } },
      { type: "text", text: " and ", styles: {} },
      { type: "text", text: "b2", styles: { bold: true } },
      { type: "text", text: " and ", styles: {} },
      { type: "text", text: "i2", styles: { italic: true } },
      { type: "text", text: " and ", styles: {} },
      { type: "text", text: "code", styles: { code: true } },
      { type: "text", text: " and ", styles: {} },
      { type: "link", text: "link", href: "https://example.org" },
      { type: "text", text: " end", styles: {} },
    ]);
    // Maths and snake_case words are not styled.
    expect(inlineRuns("2 * 3 * 4 and snake_case_name")).toEqual([
      { type: "text", text: "2 * 3 * 4 and snake_case_name", styles: {} },
    ]);
    // Markup that would be hostile is only text here: a later check decides what a link may be.
    expect(inlineRuns("<script>alert(1)</script>")).toEqual([
      { type: "text", text: "<script>alert(1)</script>", styles: {} },
    ]);
  });

  test("the lines at the top give the facts; the rest is the text", () => {
    expect(
      frontMatter('---\ntitle: "My page"\nslug: my-page\nstatus: published\n---\nBody text'),
    ).toEqual({
      meta: { title: "My page", slug: "my-page", status: "published" },
      body: "Body text",
    });
    expect(frontMatter("No facts here\n---\nnot front matter")).toEqual({
      meta: {},
      body: "No facts here\n---\nnot front matter",
    });
    expect(frontMatter("﻿---\r\ntitle: Windows\r\n---\r\ntext").meta).toEqual({ title: "Windows" });
  });

  test("the blocks: the title heading is taken out; headings, lists, quote, code, divider and picture are kept in order", () => {
    const { title, blocks } = markdownToBlocks(
      [
        "# Title",
        "",
        "Line one",
        "line two.",
        "",
        "## Sub",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2) second",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "> quoted",
        "> text",
        "",
        "```js",
        "let a = 1;",
        "",
        "let b = 2;",
        "```",
        "",
        "---",
        "",
        "![A cat](/cat.png)",
        "",
        "## Second heading",
      ].join("\n"),
    );
    expect(title).toBe("Title");
    const b = blocks as {
      id: string;
      type: string;
      props: Record<string, unknown>;
      content: unknown;
    }[];
    expect(b.map((x) => x.type)).toEqual([
      "paragraph",
      "heading",
      "bulletList",
      "bulletList",
      "numberedList",
      "numberedList",
      "taskList",
      "taskList",
      "quote",
      "codeBlock",
      "divider",
      "image",
      "heading",
    ]);
    expect(b[0]!.content).toEqual([{ type: "text", text: "Line one line two.", styles: {} }]);
    expect(b[1]!.props).toEqual({ level: 2 });
    expect(b[6]!.props).toEqual({ checked: true });
    expect(b[7]!.props).toEqual({ checked: false });
    expect(b[8]!.content).toEqual([{ type: "text", text: "quoted text", styles: {} }]);
    expect(b[9]!.props).toEqual({ language: "js" });
    expect(b[9]!.content).toEqual([{ type: "text", text: "let a = 1;\n\nlet b = 2;", styles: {} }]);
    expect(b[11]!.props).toEqual({ src: "/cat.png", alt: "A cat" });
    // Every block has its own id.
    expect(new Set(b.map((x) => x.id)).size).toBe(b.length);
    // A second level-one heading is a heading, not another title.
    expect(markdownToBlocks("# One\n\n# Two").blocks).toHaveLength(1);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: importing Markdown files`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let contributor: Actor;

    beforeEach(async () => {
      db = await open();
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
      contributor = actorOf(result.userId, "contributor");
    });
    afterEach(async () => {
      await db.close();
    });

    const entry = async (id: string) =>
      (
        await db.runner.all(
          `select "title", "slug", "status", "plain_text", "html", "type_key" from "entries" where "id" = ?`,
          [id],
        )
      )[0]!;

    test("each file becomes a page or post; one that asks to be published must pass the publish check", async () => {
      const result = await importPagesFromMarkdown(db.runner, admin, siteId, [
        {
          name: "about.md",
          text: "---\ntitle: About the garden\nslug: about-the-garden\nstatus: published\n---\n# Ignored heading\n\nWe grow **plants**.\n\n- roses\n- ferns\n",
        },
        {
          name: "gallery.md",
          text: "---\nstatus: published\n---\n# Gallery\n\n![](/uploads/none.png)\n",
        },
        { name: "my-notes.md", text: "Just some words here.\n" },
        {
          name: "news.md",
          text: "---\ntype: post\nstatus: published\n---\n# Spring news\n\nThe first seeds are in.\n",
        },
        { name: "odd.md", text: "---\nstatus: soon\n---\n# Odd one\n\nWords." },
        { name: "empty.md", text: "---\ntitle: Empty one\nstatus: published\n---\n" },
        { name: "huge.md", text: "x".repeat(MAX_MARKDOWN_FILE_CHARS + 1) },
      ]);
      if (!result.ok) throw new Error(result.message);
      const byName = (n: string) => result.items.find((i) => i.name === n)!;

      // Published, with the title and address from the file, the words and the list written to the page.
      expect(byName("about.md")).toMatchObject({
        outcome: "created",
        status: "published",
        slug: "about-the-garden",
      });
      const about = await entry(byName("about.md").id!);
      expect(about).toMatchObject({
        title: "About the garden",
        status: "published",
        type_key: "page",
      });
      expect(about["plain_text"]).toBe("We grow plants.\nroses\nferns");
      expect(String(about["html"])).toContain("<strong>plants</strong>");
      expect(String(about["html"])).toContain("<ul><li>roses</li><li>ferns</li></ul>");
      // A picture with no description keeps the page from going live: a draft, with the reason.
      expect(byName("gallery.md")).toMatchObject({ outcome: "created", status: "draft" });
      expect(byName("gallery.md").note).toMatch(/Kept as a draft\. Picture 1 has no description/);
      // No facts at all: the title is the file's name, a draft.
      expect(await entry(byName("my-notes.md").id!)).toMatchObject({
        title: "my notes",
        status: "draft",
      });
      // A post goes under the posts' address and is published.
      expect(byName("news.md")).toMatchObject({ status: "published" });
      expect(await entry(byName("news.md").id!)).toMatchObject({
        title: "Spring news",
        type_key: "post",
      });
      // A status that is not one: a draft, and it says so.
      expect(byName("odd.md")).toMatchObject({ status: "draft" });
      expect(byName("odd.md").note).toMatch(/"soon" is not a status/);
      // Asked to be published with nothing in it: a draft.
      expect(byName("empty.md").note).toMatch(/It has no content yet/);
      // Too big: skipped and said so; nothing is left of it.
      expect(byName("huge.md")).toMatchObject({ outcome: "skipped" });
      expect(byName("huge.md").note).toMatch(/too big/);
      expect(result).toMatchObject({ created: 6, published: 2, keptAsDrafts: 2, skipped: 1 });
      // The report is in the order of the files, and the import is in the log.
      expect(result.items.map((i) => i.row)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const log = await db.run(
        `select "detail" from "audit_log" where "action" = 'content.import'`,
      );
      expect(log).toHaveLength(1);
      expect(JSON.stringify(log[0]!["detail"])).toContain("markdown");
    });

    test("a person who may not publish gets drafts; no files and too many files are refused", async () => {
      const draft = await importPagesFromMarkdown(db.runner, contributor, siteId, [
        { name: "a.md", text: "---\nstatus: published\n---\n# Mine\n\nWords." },
      ]);
      if (!draft.ok) throw new Error(draft.message);
      expect(draft.items[0]).toMatchObject({ status: "draft" });
      expect(draft.items[0]!.note).toMatch(/may not publish/);
      expect(await importPagesFromMarkdown(db.runner, admin, siteId, [])).toMatchObject({
        ok: false,
      });
      const many = Array.from({ length: MAX_MARKDOWN_FILES + 1 }, (_, i) => ({
        name: `f${i}.md`,
        text: "# T",
      }));
      expect(await importPagesFromMarkdown(db.runner, admin, siteId, many)).toMatchObject({
        ok: false,
        message: /At most 100/,
      });
    });
  });
}
