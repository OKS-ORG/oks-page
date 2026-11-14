import { describe, expect, test } from "vitest";
import {
  allIds,
  blockLabel,
  duplicateBlock,
  findBlock,
  hiddenScreens,
  hiddenWords,
  insertBlocks,
  isContentBlock,
  layoutTitle,
  moveBlock,
  removeBlock,
  replaceBlock,
  setHidden,
  setProps,
  type LayoutBlock,
} from "./layout-tree";

const b = (
  id: string,
  type = "paragraph",
  children: LayoutBlock[] = [],
  props = {},
  content: unknown = null,
) => ({
  id,
  type,
  props,
  content,
  children,
});
const ids = (blocks: LayoutBlock[]): unknown[] =>
  blocks.map((x) => (x.children.length ? [x.id, ids(x.children)] : x.id));
const layout = () => [
  b("h", "part", [], { name: "header" }),
  b("m", "section", [b("t", "post-title"), b("c", "post-content")], { tag: "main" }),
  b("f", "part", [], { name: "footer" }),
];

describe("changing a layout in the site editor", () => {
  test("move up and down inside the same list, and not past its ends", () => {
    expect(ids(moveBlock(layout(), "c", -1))).toEqual(["h", ["m", ["c", "t"]], "f"]);
    expect(ids(moveBlock(layout(), "m", 1))).toEqual(["h", "f", ["m", ["t", "c"]]]);
    expect(ids(moveBlock(layout(), "h", -1))).toEqual(ids(layout()));
    expect(ids(moveBlock(layout(), "c", 1))).toEqual(ids(layout()));
  });

  test("delete, duplicate with new ids for everything inside, and find", () => {
    expect(ids(removeBlock(layout(), "t"))).toEqual(["h", ["m", ["c"]], "f"]);
    const copied = duplicateBlock(layout(), "m");
    expect(copied.blocks).toHaveLength(4);
    const copy = copied.blocks[2]!;
    expect(copy.id).toBe(copied.id);
    expect(copy.children.map((c) => c.type)).toEqual(["post-title", "post-content"]);
    // Every id is different: the copy never shares one with the original.
    expect(allIds(copied.blocks).size).toBe(8);
    expect(findBlock(layout(), "c")?.type).toBe("post-content");
    expect(findBlock(layout(), "nope")).toBeNull();
  });

  test("add after a block, inside a section at its end, or at the end of the layout", () => {
    expect(ids(insertBlocks(layout(), "h", [b("x")]))).toEqual(["h", "x", ["m", ["t", "c"]], "f"]);
    expect(ids(insertBlocks(layout(), "m", [b("x")]))).toEqual(["h", ["m", ["t", "c", "x"]], "f"]);
    expect(ids(insertBlocks(layout(), "t", [b("x")]))).toEqual(["h", ["m", ["t", "x", "c"]], "f"]);
    expect(ids(insertBlocks(layout(), null, [b("x")]))).toEqual(["h", ["m", ["t", "c"]], "f", "x"]);
  });

  test("replace a block by several, and change settings", () => {
    expect(ids(replaceBlock(layout(), "t", [b("y"), b("z")]))).toEqual([
      "h",
      ["m", ["y", "z", "c"]],
      "f",
    ]);
    const changed = setProps(layout(), "f", { name: "header" });
    expect(changed[2]!.props).toEqual({ name: "header" });
    expect(layout()[2]!.props).toEqual({ name: "footer" });
  });

  test("plain names: screens never say part, pattern or template (spec 05, 17.2)", () => {
    expect(layout().map(blockLabel)).toEqual(["Header", "Main area", "Footer"]);
    expect(blockLabel(b("x", "menu", [], { place: "footer" }))).toBe("Menu: footer");
    expect(
      blockLabel(b("x", "paragraph", [], {}, [{ type: "text", text: "Open every day" }])),
    ).toBe("Text: Open every day");
    expect(blockLabel(b("x", "section", [], { tag: "div", name: "hero" }))).toBe('Group "hero"');
    expect(isContentBlock(b("x", "heading"))).toBe(true);
    expect(isContentBlock(b("x", "menu"))).toBe(false);
    expect(layoutTitle("templates/single-post", "")).toBe("Blog post");
    expect(layoutTitle("templates/front-page", "")).toBe("Home");
    expect(layoutTitle("parts/footer", "Bottom")).toBe("Footer");
    expect(layoutTitle("templates/single-recipe", "")).toBe("Recipe (one entry)");
    expect(layoutTitle("templates/landing", "Landing page")).toBe("Landing page");
  });

  test("hide a block on some screens, and show it again", () => {
    const hidden = setHidden(layout(), "t", ["desktop", "phone"]);
    const t = findBlock(hidden, "t")!;
    expect(t.props["hide"]).toEqual(["phone", "desktop"]);
    expect(hiddenScreens(t)).toEqual(["phone", "desktop"]);
    expect(hiddenWords(t)).toBe("hidden on phone and desktop");
    expect(
      hiddenWords(findBlock(setHidden(hidden, "t", ["phone", "tablet", "desktop"]), "t")!),
    ).toBe("hidden on every screen");
    const shown = findBlock(setHidden(hidden, "t", []), "t")!;
    expect("hide" in shown.props).toBe(false);
    expect(hiddenWords(shown)).toBe("");
    expect(findBlock(layout(), "t")!.props).toEqual({});
  });
});
