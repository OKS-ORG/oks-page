// Free positioning (spec 06, section 7): a block can be placed with `position: absolute` inside a block set to
// `position: relative`. The place is only known when the block has a width, a height and a place, and its container has a
// height. These checks say in plain words what is missing or what overlaps, for each screen size that is on. Nothing here
// stops a save: free positioning is the owner's choice, the editor only warns.
import type { Block } from "./blocks.js";
import { breakpointRanges, checkStyle, DEFAULT_BREAKPOINTS, SCREEN_LABELS } from "./styles.js";
import type { Style } from "./styles.js";

type Declarations = Record<string, string>;

/** The values that apply on one screen size: the smallest size first, each larger size on top (mobile first). */
export function effectiveStyle(style: Style, sizes: readonly string[], upTo: string): Declarations {
  const out: Declarations = {};
  for (const range of breakpointRanges(sizes)) {
    Object.assign(out, style[range.name] ?? {});
    if (range.name === upTo) break;
  }
  return out;
}

const styleOf = (block: Block, sizes: readonly string[]): Style =>
  checkStyle((block.props as Record<string, unknown>)["style"], sizes).style;

const px = (value: string | undefined): number | null => {
  const m = /^(-?\d+(\.\d+)?)px$/.exec(value ?? "");
  return m ? Number(m[1]) : null;
};

interface Found {
  block: Block;
  parent: Block | null;
}

function find(blocks: Block[], id: string, parent: Block | null = null): Found | null {
  for (const block of blocks) {
    if (block.id === id) return { block, parent };
    const inner = find(block.children ?? [], id, block);
    if (inner) return inner;
  }
  return null;
}

const nameOf = (block: Block): string => block.type;

/** What is missing or overlapping for the chosen block, in plain sentences. Empty when it is not placed freely. */
export function positionWarnings(
  blocks: Block[],
  id: string,
  sizes: readonly string[] = DEFAULT_BREAKPOINTS,
): string[] {
  const found = find(blocks, id);
  if (!found) return [];
  const out: string[] = [];
  const names = SCREEN_LABELS;
  for (const range of breakpointRanges(sizes)) {
    const mine = effectiveStyle(styleOf(found.block, sizes), sizes, range.name);
    if (mine["position"] !== "absolute") continue;
    const where = (names[range.name] ?? range.name).toLowerCase();
    const missing: string[] = [];
    if (!mine["width"] && !mine["inline-size"]) missing.push("a width");
    if (!mine["height"] && !mine["block-size"]) missing.push("a height");
    if (!mine["top"] && !mine["bottom"]) missing.push("a place from the top or bottom");
    if (!mine["inset-inline-start"] && !mine["inset-inline-end"])
      missing.push("a place from the start or end");
    if (missing.length > 0)
      out.push(`On ${where}, this block needs ${missing.join(", ")}; its place is not known.`);
    const parent = found.parent;
    if (!parent) {
      out.push(`On ${where}, a block placed freely needs to sit inside another block.`);
      continue;
    }
    const outer = effectiveStyle(styleOf(parent, sizes), sizes, range.name);
    if (outer["position"] !== "relative" && outer["position"] !== "absolute")
      out.push(
        `On ${where}, the block it sits in (${nameOf(parent)}) must be set to a relative position, or this block is placed against the whole page.`,
      );
    else if (!outer["height"] && !outer["min-height"] && !outer["block-size"])
      out.push(
        `On ${where}, the block it sits in (${nameOf(parent)}) needs a height, or it shrinks to nothing.`,
      );
    // Overlap with the other freely placed blocks in the same container, when every number is in pixels.
    const box = (b: Block) => {
      const s = effectiveStyle(styleOf(b, sizes), sizes, range.name);
      if (s["position"] !== "absolute") return null;
      const x = px(s["inset-inline-start"]);
      const y = px(s["top"]);
      const w = px(s["width"] ?? s["inline-size"]);
      const h = px(s["height"] ?? s["block-size"]);
      return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
    };
    const a = box(found.block);
    if (a)
      for (const other of parent.children ?? []) {
        if (other.id === found.block.id) continue;
        const c = box(other);
        if (c && a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h)
          out.push(`On ${where}, this block overlaps another block (${nameOf(other)}).`);
      }
  }
  return out;
}
