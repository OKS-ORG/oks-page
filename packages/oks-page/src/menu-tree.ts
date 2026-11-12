// Editing a menu tree on the screen: move an item up or down, make it a sub-item, move it out, rename it, remove it.
// Each function returns a new tree and never changes the one it is given. The rules match the server's (at most three
// levels deep), which checks the saved tree again.
import type { MenuItem } from "@oks-page/core";

export const MAX_DEPTH = 3;

interface Spot {
  list: MenuItem[];
  index: number;
  depth: number;
  parent: Spot | null;
}

function locate(list: MenuItem[], id: string, depth = 1, parent: Spot | null = null): Spot | null {
  for (let index = 0; index < list.length; index++) {
    const here: Spot = { list, index, depth, parent };
    if (list[index]!.id === id) return here;
    const inner = locate(list[index]!.children, id, depth + 1, here);
    if (inner) return inner;
  }
  return null;
}

export const height = (item: MenuItem): number =>
  1 + Math.max(0, ...item.children.map((c) => height(c)));

export const findItem = (items: MenuItem[], id: string): MenuItem | null => {
  const spot = locate(items, id);
  return spot ? spot.list[spot.index]! : null;
};

export function canMoveUp(items: MenuItem[], id: string): boolean {
  const spot = locate(items, id);
  return !!spot && spot.index > 0;
}

export function canMoveDown(items: MenuItem[], id: string): boolean {
  const spot = locate(items, id);
  return !!spot && spot.index < spot.list.length - 1;
}

/** An item becomes the last sub-item of the one above it, if that keeps the tree within three levels. */
export function canIndent(items: MenuItem[], id: string): boolean {
  const spot = locate(items, id);
  return !!spot && spot.index > 0 && spot.depth + height(spot.list[spot.index]!) <= MAX_DEPTH;
}

export function canOutdent(items: MenuItem[], id: string): boolean {
  const spot = locate(items, id);
  return !!spot && spot.parent !== null;
}

function change(items: MenuItem[], id: string, how: (spot: Spot) => void): MenuItem[] {
  const next = structuredClone(items);
  const spot = locate(next, id);
  if (spot) how(spot);
  return next;
}

export const moveUp = (items: MenuItem[], id: string): MenuItem[] =>
  !canMoveUp(items, id)
    ? items
    : change(items, id, ({ list, index }) => {
        [list[index - 1], list[index]] = [list[index]!, list[index - 1]!];
      });

export const moveDown = (items: MenuItem[], id: string): MenuItem[] =>
  !canMoveDown(items, id)
    ? items
    : change(items, id, ({ list, index }) => {
        [list[index], list[index + 1]] = [list[index + 1]!, list[index]!];
      });

export const indent = (items: MenuItem[], id: string): MenuItem[] =>
  !canIndent(items, id)
    ? items
    : change(items, id, ({ list, index }) => {
        const [item] = list.splice(index, 1);
        list[index - 1]!.children.push(item!);
      });

export const outdent = (items: MenuItem[], id: string): MenuItem[] =>
  !canOutdent(items, id)
    ? items
    : change(items, id, ({ list, index, parent }) => {
        const [item] = list.splice(index, 1);
        parent!.list.splice(parent!.index + 1, 0, item!);
      });

export const removeItem = (items: MenuItem[], id: string): MenuItem[] =>
  change(items, id, ({ list, index }) => {
    list.splice(index, 1);
  });

export const rename = (items: MenuItem[], id: string, label: string): MenuItem[] =>
  change(items, id, ({ list, index }) => {
    list[index]!.label = label;
  });

/** A new item goes to the end of the top level. */
export const addItem = (items: MenuItem[], item: MenuItem): MenuItem[] => [
  ...structuredClone(items),
  item,
];

export function countItems(items: MenuItem[]): number {
  return items.reduce((n, i) => n + 1 + countItems(i.children), 0);
}
