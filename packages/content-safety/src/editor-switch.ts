// Switching an entry between the writing editor and the layout editor (spec 06, section 13).
import type { Block } from "./blocks.js";

/** Blocks only the layout editor draws and edits. Everything else flows in a document. */
export const LAYOUT_ONLY = new Set([
  "section",
  "container",
  "columns",
  "column",
  "spacer",
  // The spec offers the buttons in the writing editor too; oks-ui's editor does not draw them yet.
  "button",
  "buttonGroup",
  "gallery",
  "audio",
  "icon",
  "map",
  "socialLinks",
  "accordion",
  "tabs",
  "tab",
  "slider",
  "slide",
  "site-logo",
  "site-title",
  "menu",
  "language-switch",
  "query-loop",
  "pagination",
  "post-title",
  "post-content",
  "post-meta",
  "post-featured-image",
  "breadcrumbs",
  "search-form",
]);

const newId = (): string => globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 26);

/** Writing to layout: every block, its order and its text are kept. Loose blocks at the top go inside a section. */
export function wrapForLayout(blocks: Block[]): Block[] {
  const out: Block[] = [];
  let loose: Block[] = [];
  const close = (): void => {
    if (loose.length === 0) return;
    out.push({ id: newId(), type: "section", props: {}, content: null, children: loose });
    loose = [];
  };
  for (const block of blocks) {
    if (block.type === "section") {
      close();
      out.push(block);
    } else loose.push(block);
  }
  close();
  return out;
}

export interface FlattenResult {
  blocks: Block[];
  /** Plain sentences for what would be lost. Empty when the body is flow-only. */
  lost: string[];
}

const hasStyle = (b: Block): boolean => b.props["style"] !== undefined && b.props["style"] !== null;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Layout to writing: layout blocks become a plain flow. `lost` lists what that costs; a flow-only body loses nothing. */
export function flattenForWriting(blocks: Block[]): FlattenResult {
  let columns = 0;
  let containers = 0;
  let spacers = 0;
  let styled = 0;
  let other = 0;
  let sections = 0;
  const flat = (list: Block[]): Block[] =>
    list.flatMap((b): Block[] => {
      if (hasStyle(b)) styled++;
      const children = flat(b.children);
      switch (b.type) {
        case "section":
          // A plain section (no settings of its own) is just a wrapper.
          if (Object.keys(b.props).filter((k) => k !== "style" && k !== "width").length > 0)
            sections++;
          return children;
        case "container":
          containers++;
          return children;
        case "columns":
          columns++;
          return children;
        case "column":
          return children;
        case "spacer":
          spacers++;
          return [];
        default:
          if (LAYOUT_ONLY.has(b.type)) {
            other++;
            return [];
          }
          return [{ ...b, props: withoutStyle(b.props), children }];
      }
    });
  const result = flat(blocks);
  const lost: string[] = [];
  if (columns)
    lost.push(
      `${plural(columns, "set of columns", "sets of columns")} would become one flow of content.`,
    );
  if (containers)
    lost.push(
      `${plural(containers, "container", "containers")} would be removed; what is inside stays.`,
    );
  if (sections)
    lost.push(`The settings of ${plural(sections, "section", "sections")} would be removed.`);
  if (spacers) lost.push(`${plural(spacers, "spacer", "spacers")} would be removed.`);
  if (styled)
    lost.push(
      `The spacing, colours and sizes of ${plural(styled, "block", "blocks")} would be removed.`,
    );
  if (other)
    lost.push(
      `${plural(other, "block", "blocks")} that only the layout editor can show would be removed.`,
    );
  return { blocks: result, lost };
}

function withoutStyle(props: Record<string, unknown>): Record<string, unknown> {
  const { style: _style, ...rest } = props;
  void _style;
  return rest;
}
