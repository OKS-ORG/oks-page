import type { MenuItem } from "@oks-page/core";
import { describe, expect, test } from "vitest";
import {
  addItem,
  canIndent,
  canMoveDown,
  canMoveUp,
  canOutdent,
  countItems,
  findItem,
  indent,
  moveDown,
  moveUp,
  outdent,
  removeItem,
  rename,
} from "./menu-tree";

const item = (id: string, children: MenuItem[] = []): MenuItem => ({
  id,
  label: id.toUpperCase(),
  kind: "url",
  url: "/" + id,
  children,
});
const shape = (items: MenuItem[]): unknown =>
  items.map((i) => (i.children.length ? [i.id, shape(i.children)] : i.id));

describe("editing a menu tree", () => {
  const tree = () => [item("a"), item("b", [item("c")]), item("d")];

  test("up and down swap neighbours, and the ends cannot move further", () => {
    expect(shape(moveDown(tree(), "a"))).toEqual([["b", ["c"]], "a", "d"]);
    expect(shape(moveUp(tree(), "d"))).toEqual(["a", "d", ["b", ["c"]]]);
    expect(canMoveUp(tree(), "a")).toBe(false);
    expect(canMoveDown(tree(), "d")).toBe(false);
    expect(shape(moveUp(tree(), "a"))).toEqual(shape(tree()));
    expect(shape(moveDown(tree(), "d"))).toEqual(shape(tree()));
  });

  test("an item moves inside its own list only", () => {
    expect(canMoveUp(tree(), "c")).toBe(false);
    expect(canMoveDown(tree(), "c")).toBe(false);
  });

  test("indent puts an item under the one above it, at the end", () => {
    expect(shape(indent(tree(), "d"))).toEqual(["a", ["b", ["c", "d"]]]);
    expect(canIndent(tree(), "a")).toBe(false); // nothing above it
    expect(shape(indent(tree(), "a"))).toEqual(shape(tree()));
  });

  test("outdent puts a sub-item after its parent", () => {
    expect(shape(outdent(tree(), "c"))).toEqual(["a", "b", "c", "d"]);
    expect(canOutdent(tree(), "a")).toBe(false);
  });

  test("a tree never goes deeper than three levels", () => {
    const deep = [item("a", [item("b", [item("c")])]), item("d")];
    // d under a would be level 2; fine. But a (with two levels below) cannot go under anything.
    const two = [item("x"), item("a", [item("b", [item("c")])])];
    expect(canIndent(two, "a")).toBe(false);
    expect(shape(indent(two, "a"))).toEqual(shape(two));
    expect(canIndent(deep, "d")).toBe(true);
    // c is at level 3: the item above it does not exist, so it cannot be indented.
    expect(canIndent(deep, "c")).toBe(false);
    const level3 = [item("a", [item("b", [item("c"), item("e")])])];
    expect(canIndent(level3, "e")).toBe(false); // would be level 4
  });

  test("rename, remove and add", () => {
    expect(findItem(rename(tree(), "c", "Sea"), "c")!.label).toBe("Sea");
    expect(shape(removeItem(tree(), "b"))).toEqual(["a", "d"]); // its sub-items go with it
    expect(shape(addItem(tree(), item("z")))).toEqual(["a", ["b", ["c"]], "d", "z"]);
    expect(countItems(tree())).toBe(4);
  });

  test("the tree that was passed in is never changed", () => {
    const before = tree();
    const copy = structuredClone(before);
    moveDown(before, "a");
    indent(before, "d");
    outdent(before, "c");
    removeItem(before, "b");
    rename(before, "a", "X");
    expect(before).toEqual(copy);
  });

  test("an unknown id changes nothing", () => {
    expect(shape(moveUp(tree(), "nope"))).toEqual(shape(tree()));
    expect(shape(removeItem(tree(), "nope"))).toEqual(shape(tree()));
    expect(findItem(tree(), "nope")).toBeNull();
  });
});
