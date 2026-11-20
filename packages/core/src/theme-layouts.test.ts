import type { Block } from "@oks-page/content-safety";
import { describe, expect, test } from "vitest";
import {
  hiddenOn,
  layoutCandidates,
  partsUsedBy,
  pickLayout,
  toDrawNodes,
  type DrawNode,
  type ThemeLayouts,
} from "./theme-layouts.js";

const block = (
  type: string,
  props: Record<string, unknown> = {},
  children: Block[] = [],
  content: unknown = null,
): Block => ({ id: Math.random().toString(36).slice(2, 10), type, props, content, children });
const paragraph = (text: string) => block("paragraph", {}, [], [{ type: "text", text }]);

describe("which layout a page uses", () => {
  test("the most specific layout first, then the general ones, then index", () => {
    expect(layoutCandidates({ kind: "entry", type: "page", slug: "home" })).toEqual([
      "front-page",
      "page-home",
      "page",
      "index",
    ]);
    expect(layoutCandidates({ kind: "entry", type: "page", slug: "about/team" })).toEqual([
      "page-about-team",
      "page",
      "index",
    ]);
    // The list of a custom type: its own layout, then the archive layout.
    expect(layoutCandidates({ kind: "type-list", type: "gadget" })).toEqual([
      "list-gadget",
      "archive",
      "index",
    ]);
    expect(layoutCandidates({ kind: "entry", type: "post", slug: "hello" })).toEqual([
      "single-post-hello",
      "single-post",
      "single",
      "index",
    ]);
    expect(layoutCandidates({ kind: "archive", termKind: "tag" })).toEqual([
      "tag",
      "archive",
      "index",
    ]);
    expect(layoutCandidates({ kind: "search" })).toEqual(["search", "index"]);
    // An address with letters a layout name cannot hold is simply not tried.
    expect(layoutCandidates({ kind: "entry", type: "post", slug: "café" })).toEqual([
      "single-post",
      "single",
      "index",
    ]);
  });

  test("the first layout the theme has wins; no theme or no match means the built-in page", () => {
    const layouts: ThemeLayouts = {
      templates: {
        index: [{ kind: "html", html: "<p>i</p>" }],
        single: [{ kind: "html", html: "<p>s</p>" }],
      },
      parts: {},
    };
    expect(pickLayout(layouts, ["single-post", "single", "index"])).toBe(
      layouts.templates["single"],
    );
    expect(pickLayout(layouts, ["page", "index"])).toBe(layouts.templates["index"]);
    expect(pickLayout({ templates: {}, parts: {} }, ["index"])).toBeNull();
    expect(pickLayout(null, ["index"])).toBeNull();
    // Names that are not the theme's own layouts are never found.
    expect(pickLayout(layouts, ["constructor", "toString"])).toBeNull();
  });
});

describe("turning a layout into a draw tree", () => {
  test("content runs become HTML from the block writer; site blocks stay; sections keep their children", () => {
    const nodes = toDrawNodes([
      block("part", { name: "header" }),
      paragraph("one"),
      paragraph("two"),
      block("section", { tag: "main" }, [
        block("post-title"),
        paragraph("inside"),
        block("post-content"),
      ]),
      block("menu", { place: "footer" }, [paragraph("children of a site block are not drawn")]),
    ]);
    expect(nodes.map((n) => (n.kind === "html" ? "html" : n.type))).toEqual([
      "part",
      "html",
      "section",
      "menu",
    ]);
    const html = nodes[1]!;
    expect(html.kind === "html" && html.html).toContain("one");
    expect(html.kind === "html" && html.html).toContain("two");
    const section = nodes[2]!;
    if (section.kind !== "site") throw new Error("not a site block");
    expect(section.props).toEqual({ tag: "main" });
    expect(section.children.map((n) => (n.kind === "html" ? "html" : n.type))).toEqual([
      "post-title",
      "html",
      "post-content",
    ]);
    const menu = nodes[3]!;
    expect(menu.kind === "site" && menu.children).toEqual([]);
  });
});

describe("the site editor's preview and banner", () => {
  test("split: every content block on its own, and every node keeps its block id", () => {
    const one = paragraph("one");
    const two = paragraph("two");
    const title = block("post-title");
    const nodes = toDrawNodes([one, two, block("section", {}, [title])], { split: true });
    expect(nodes.map((n) => [n.kind, n.id])).toEqual([
      ["html", one.id],
      ["html", two.id],
      ["site", nodes[2]!.id],
    ]);
    const section = nodes[2]!;
    expect(section.kind === "site" && section.children[0]!.id).toBe(title.id);
    // Without split, ids are not kept and content runs are joined.
    expect(toDrawNodes([one, two]).map((n) => n.id)).toEqual([undefined]);
  });

  test("the parts a layout draws, through other parts, without looping", () => {
    const part = (name: string): DrawNode => ({
      kind: "site",
      type: "part",
      props: { name },
      children: [],
    });
    const parts: Record<string, DrawNode[]> = {
      header: [part("brand")],
      brand: [part("header")],
      footer: [],
    };
    const layout: DrawNode[] = [
      part("header"),
      { kind: "site", type: "section", props: {}, children: [part("footer")] },
      part("missing"),
    ];
    expect(partsUsedBy(layout, parts).sort()).toEqual(["brand", "footer", "header"]);
  });
});

describe("hiding a block on phone, tablet or desktop (spec 05, 17.5; spec 06, PB-97)", () => {
  test("only known screens count, each once, in order", () => {
    expect(hiddenOn({ hide: ["desktop", "phone", "phone", "watch", 3] })).toEqual([
      "phone",
      "desktop",
    ]);
    expect(hiddenOn({ hide: "phone" })).toEqual([]);
    expect(hiddenOn({})).toEqual([]);
  });

  test("a hidden content block is written on its own, so its neighbours still show", () => {
    const one = paragraph("one");
    const two = { ...paragraph("two"), props: { hide: ["phone"] } };
    const three = paragraph("three");
    const four = paragraph("four");
    const nodes = toDrawNodes([one, two, three, four]);
    expect(nodes.map((n) => [n.kind === "html" && n.html.includes("one"), n.hide ?? []])).toEqual([
      [true, []],
      [false, ["phone"]],
      [false, []],
    ]);
    expect(nodes[2]!.kind === "html" && nodes[2]!.html).toContain("four");
    // A site block keeps its hiding too, inside sections as well.
    const inner = block("search-form", { hide: ["tablet", "desktop"] });
    const tree = toDrawNodes([block("section", {}, [inner])]);
    const section = tree[0]!;
    expect(section.kind === "site" && section.children[0]!.hide).toEqual(["tablet", "desktop"]);
    expect(section.hide).toBeUndefined();
  });
});
