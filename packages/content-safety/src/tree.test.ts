// The block tree rules of the layout editor (spec 06, section 3; PB-20 to PB-24, PB-34 to PB-38).
import { describe, expect, test } from "vitest";
import { checkBlocks, type Block } from "./index.js";
import {
  applyOp,
  countBlocks,
  duplicateBlock,
  duplicateInPlace,
  insertBlock,
  moveBlock,
  placementProblem,
  removeBlock,
  updateProps,
  type TreeResult,
} from "./tree.js";

let n = 0;
const b = (type: string, children: Block[] = [], props: Record<string, unknown> = {}): Block => ({
  id: `t${++n}`,
  type,
  props,
  content: null,
  children,
});
const tree = (r: TreeResult): Block[] => {
  if (!r.ok) throw new Error(r.message);
  return r.tree;
};
const message = (r: TreeResult): string => (r.ok ? "" : r.message);

describe("where a block may go (PB-20)", () => {
  test("a column only inside columns, and columns accepts only columns", () => {
    expect(placementProblem("columns", "column")).toBeNull();
    expect(placementProblem("container", "column")).toBe(
      "A column can only go inside a columns block.",
    );
    expect(placementProblem("columns", "paragraph")).toContain("Put it inside a column");
    expect(placementProblem(null, "column")).not.toBeNull();
  });

  test("a section only at the top, a button group only buttons, a spacer holds nothing", () => {
    expect(placementProblem(null, "section")).toBeNull();
    expect(placementProblem("container", "section")).toContain("only be at the top");
    expect(placementProblem("buttonGroup", "paragraph")).toContain("holds only buttons");
    expect(placementProblem("buttonGroup", "button")).toBeNull();
    expect(placementProblem("spacer", "paragraph")).toContain("cannot hold other blocks");
  });

  test("a refusal is a plain sentence and leaves the tree as it was", () => {
    const start = [b("section", [b("container", [], {}), b("paragraph")])];
    const containerId = start[0]!.children[0]!.id;
    const before = JSON.stringify(start);
    const r = insertBlock(start, containerId, 0, b("column"));
    expect(r.ok).toBe(false);
    expect(message(r)).toBe("A column can only go inside a columns block.");
    expect(JSON.stringify(start)).toBe(before);
  });
});

describe("the interactive and media blocks keep their own children (PB-20)", () => {
  test("tabs hold only tabs, a slider only slides, an accordion only items; a tab or slide goes nowhere else", () => {
    expect(placementProblem("tabs", "tab")).toBeNull();
    expect(placementProblem("tabs", "paragraph")).toContain("holds only tabs");
    expect(placementProblem("container", "tab")).toBe("A tab can only go inside a tabs block.");
    expect(placementProblem("slider", "slide")).toBeNull();
    expect(placementProblem("container", "slide")).toBe("A slide can only go inside a slider.");
    expect(placementProblem("accordion", "toggle")).toBeNull();
    expect(placementProblem("accordion", "paragraph")).toContain("holds only accordion items");
    expect(placementProblem("gallery", "paragraph")).toContain("cannot hold other blocks");
  });
});

describe("moving (PB-21, PB-22)", () => {
  test("a block cannot move into itself or its own descendant", () => {
    const inner = b("container");
    const outer = b("container", [inner]);
    const start = [b("section", [outer])];
    expect(message(moveBlock(start, outer.id, outer.id, 0))).toBe(
      "A block cannot be moved into itself.",
    );
    expect(message(moveBlock(start, outer.id, inner.id, 0))).toBe(
      "A block cannot be moved into itself.",
    );
  });

  test("a move keeps every block, and its inverse puts it back", () => {
    const a = b("paragraph");
    const c = b("paragraph");
    const target = b("container");
    const start = [b("section", [a, c, target])];
    const r = moveBlock(start, a.id, target.id, 0);
    const moved = tree(r);
    expect(countBlocks(moved)).toBe(countBlocks(start));
    expect(moved[0]!.children[1]!.children[0]!.id).toBe(a.id);
    expect(r.ok && JSON.stringify(tree(applyOp(moved, r.inverse)))).toBe(JSON.stringify(start));
  });

  test("a move into a place that does not allow it is refused and changes nothing", () => {
    const col = b("column");
    const start = [b("section", [b("columns", [col]), b("paragraph")])];
    const para = start[0]!.children[1]!;
    const r = moveBlock(start, para.id, start[0]!.children[0]!.id, 0);
    expect(message(r)).toContain("Put it inside a column");
    expect(JSON.stringify(start[0]!.children[1])).toContain(para.id);
  });
});

describe("limits (PB-23)", () => {
  test("depth at most 12, with a plain sentence", () => {
    const chain = [b("container")];
    for (let i = 0; i < 11; i++) {
      const next = b("container");
      chain[i]!.children.push(next);
      chain.push(next);
    }
    const start = [chain[0]!];
    // The twelve containers fill twelve levels; one more block inside the last would be the thirteenth.
    expect(message(insertBlock(start, chain[11]!.id, 0, b("paragraph")))).toContain(
      "more than 12 levels deep",
    );
    expect(insertBlock(start, chain[10]!.id, 0, b("paragraph")).ok).toBe(true);
  });

  test("at most 5,000 blocks per page", () => {
    const many = Array.from({ length: 5000 }, () => b("paragraph"));
    expect(message(insertBlock(many, null, 0, b("paragraph")))).toBe(
      "A page can have at most 5,000 blocks.",
    );
    expect(insertBlock(many.slice(1), null, 0, b("paragraph")).ok).toBe(true);
  });
});

describe("duplicate (PB-24)", () => {
  test("every copy gets new unique ids and keeps its settings", () => {
    const start = [b("section", [b("container", [b("paragraph")], { gap: 4 })], { width: "full" })];
    const copy = duplicateBlock(start[0]!);
    const ids = (x: Block): string[] => [x.id, ...x.children.flatMap(ids)];
    const all = new Set([...ids(start[0]!), ...ids(copy)]);
    expect(all.size).toBe(6);
    expect(copy.props).toEqual({ width: "full" });
    expect(copy.children[0]!.props).toEqual({ gap: 4 });
    const placed = tree(duplicateInPlace(start, start[0]!.id));
    expect(placed).toHaveLength(2);
    expect(placed[1]!.id).not.toBe(start[0]!.id);
  });
});

describe("inverses (PB-25) and plain failures (PB-36)", () => {
  test("remove and settings changes have an exact inverse", () => {
    const x = b("paragraph", [], { align: "end" });
    const start = [b("section", [b("paragraph"), x])];
    const removed = removeBlock(start, x.id);
    expect(removed.ok && JSON.stringify(tree(applyOp(tree(removed), removed.inverse)))).toBe(
      JSON.stringify(start),
    );
    const changed = updateProps(start, x.id, { align: "center", extra: 1 });
    expect(changed.ok && JSON.stringify(tree(applyOp(tree(changed), changed.inverse)))).toBe(
      JSON.stringify(start),
    );
  });

  test("a block that is not on the page gives a plain sentence", () => {
    expect(message(removeBlock([], "nope"))).toBe("That block is no longer on the page.");
    expect(message(moveBlock([], "nope", null, 0))).toBe("That block is no longer on the page.");
    expect(message(insertBlock([], "nope", 0, b("paragraph")))).toBe(
      "That place is no longer on the page.",
    );
  });
});

describe("the block checks know the layout blocks (PB-61)", () => {
  test("they are kept, and a button's unsafe link is removed", () => {
    const { body, repairs } = checkBlocks({
      version: 1,
      blocks: [
        {
          id: "s1",
          type: "section",
          props: {},
          content: null,
          children: [
            {
              id: "b1",
              type: "button",
              props: { text: "Go", href: "javascript:alert(1)" },
              children: [],
            },
          ],
        },
      ],
    });
    expect(body.blocks[0]!.type).toBe("section");
    expect(body.blocks[0]!.children[0]!.props).toEqual({ text: "Go" });
    expect(repairs).toContain("removed_link");
  });
});
