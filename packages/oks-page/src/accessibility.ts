// The accessibility checker of the editor (spec 03, section 8; EC-41). It reads the blocks as the writer works and says,
// in plain words, what a person using a screen reader or a keyboard would struggle with. It only advises: it never stops a
// save. Pure, so the editor, the tests and (later) the publish check read the blocks the same way.
import { contrastRatio } from "@oks-page/core/theme";

/** A block as the editor holds it (only what the checker reads). */
export interface CheckedBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: CheckedBlock[];
}

export type AccessibilityRule =
  | "missing-alt"
  | "skipped-heading"
  | "empty-link"
  | "vague-link"
  | "table-header"
  | "low-contrast"
  | "long-paragraph";

export interface AccessibilityIssue {
  rule: AccessibilityRule;
  /** The id of the block to look at. */
  blockId: string;
  /** Where it is, in words: "Picture 3". */
  where: string;
  /** What to fix, in plain words. */
  message: string;
}

/** A paragraph longer than this many words is hard to follow. */
export const LONG_PARAGRAPH_WORDS = 200;
/** The ratio WCAG asks for normal text. */
const NEEDED_CONTRAST = 4.5;

const VAGUE = new Set([
  "click here",
  "here",
  "read more",
  "more",
  "learn more",
  "link",
  "this link",
  "this",
  "click",
  "details",
]);

const KIND: Record<string, string> = {
  image: "Picture",
  heading: "Heading",
  paragraph: "Paragraph",
  table: "Table",
  bulletList: "List",
  numberedList: "List",
  taskList: "List",
  quote: "Quote",
  callout: "Callout",
  toggle: "Toggle",
};

interface Run {
  type?: unknown;
  text?: unknown;
  href?: unknown;
  styles?: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isRuns = (v: unknown): v is Run[] => Array.isArray(v);
const textOf = (runs: unknown): string =>
  isRuns(runs) ? runs.map((r) => (r && typeof r === "object" ? str(r.text) : "")).join("") : "";
const hex = (v: unknown): string | null =>
  typeof v === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : null;

/** Every list of runs a block holds: its own text, and each cell of a table. */
function runLists(block: CheckedBlock): Run[][] {
  const content = block.content;
  if (isRuns(content)) return [content];
  const rows = (content as { rows?: { cells?: unknown[] }[] } | null)?.rows;
  if (Array.isArray(rows))
    return rows.flatMap((r) => (Array.isArray(r.cells) ? r.cells : [])).filter(isRuns);
  return [];
}

/**
 * What to look at in a page or post, in the order of the page. Empty when nothing was found. A picture marked
 * `decorative` needs no description.
 */
export function checkAccessibility(blocks: CheckedBlock[]): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  const counts = new Map<string, number>();
  let lastLevel = 0;

  const add = (rule: AccessibilityRule, block: CheckedBlock, where: string, message: string) =>
    issues.push({ rule, blockId: block.id, where, message });

  const walk = (list: CheckedBlock[]) => {
    for (const block of list) {
      const kind = KIND[block.type] ?? "Block";
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      const where = `${kind} ${n}`;
      const props = block.props ?? {};

      if (block.type === "image" && props["decorative"] !== true && str(props["alt"]).trim() === "")
        add(
          "missing-alt",
          block,
          where,
          "This picture has no description. Add a short description of what it shows, for people who cannot see it.",
        );

      if (block.type === "heading") {
        const level = Math.min(Math.max(Math.trunc(Number(props["level"])) || 2, 1), 6);
        if (lastLevel > 0 && level > lastLevel + 1)
          add(
            "skipped-heading",
            block,
            where,
            `This heading jumps from level ${lastLevel} to level ${level}. Use level ${lastLevel + 1} so the page keeps its order.`,
          );
        lastLevel = level;
      }

      if (block.type === "table") {
        const rows = (block.content as { rows?: unknown[] } | null)?.rows;
        if (props["headerRow"] !== true && Array.isArray(rows) && rows.length > 1)
          add(
            "table-header",
            block,
            where,
            "This table has no header row. Turn on the header row so a screen reader can name the columns.",
          );
      }

      for (const runs of runLists(block)) {
        for (const run of runs) {
          if (!run || typeof run !== "object") continue;
          if (run.type === "link") {
            // A link is text with an address, as the block checks keep it.
            const text = str(run.text).replace(/\s+/g, " ").trim();
            if (text === "")
              add(
                "empty-link",
                block,
                where,
                "A link has no text. Put words in it, so people know where it goes.",
              );
            else if (VAGUE.has(text.toLowerCase().replace(/[.!:,]+$/, "")))
              add(
                "vague-link",
                block,
                where,
                `The link "${text}" does not say where it goes. Use words that describe the page, such as "Read the opening hours".`,
              );
          }
          const color = hex(run.styles?.["color"]);
          const background = hex(run.styles?.["backgroundColor"]);
          if (color && background && str(run.text).trim() !== "") {
            const ratio = Math.floor(contrastRatio(color, background) * 10) / 10;
            if (ratio < NEEDED_CONTRAST)
              add(
                "low-contrast",
                block,
                where,
                `Some text is hard to read: its color and its background give a contrast of ${ratio.toFixed(1)} to 1; it needs ${NEEDED_CONTRAST} to 1.`,
              );
          }
        }
      }

      if (block.type === "paragraph") {
        const words = textOf(block.content).trim().split(/\s+/).filter(Boolean).length;
        if (words > LONG_PARAGRAPH_WORDS)
          add(
            "long-paragraph",
            block,
            where,
            `This paragraph has ${words} words. Split it into shorter ones so it is easier to read.`,
          );
      }

      if (block.children && block.children.length > 0) walk(block.children);
    }
  };
  walk(blocks);
  return issues;
}
