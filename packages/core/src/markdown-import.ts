// Markdown files into pages and posts (spec 03, section 9). A small reader written for this: it needs no browser and
// makes only the blocks the editor has, so every result still passes the same block checks on save. It reads headings,
// paragraphs, bullet, numbered and task lists, quotes, fenced code, dividers, pictures on a line of their own, and inside
// text bold, italic, code and links. Anything else stays as plain text; nothing is run and nothing is fetched.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import {
  importRows,
  MAX_IMPORT_CHARS,
  type ImportReport,
  type ImportResult,
  type ImportRow,
} from "./import-pages.js";

export const MAX_MARKDOWN_FILES = 100;
export const MAX_MARKDOWN_FILE_CHARS = 200_000;

type Run =
  | { type: "text"; text: string; styles: Record<string, boolean> }
  | { type: "link"; text: string; href: string };

/** Text with `**bold**`, `*italic*`, `` `code` `` and `[links](https://...)` into the editor's inline runs. */
export function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  const pattern =
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<![A-Za-z0-9])_([^_\s][^_]*)_(?![A-Za-z0-9])|`([^`]+)`/g;
  let last = 0;
  const plain = (t: string) => {
    if (t) runs.push({ type: "text", text: t, styles: {} });
  };
  for (const m of text.matchAll(pattern)) {
    plain(text.slice(last, m.index));
    if (m[1] !== undefined) runs.push({ type: "link", text: m[1], href: m[2]! });
    else if (m[3] !== undefined || m[4] !== undefined)
      runs.push({ type: "text", text: (m[3] ?? m[4])!, styles: { bold: true } });
    else if (m[5] !== undefined || m[6] !== undefined)
      runs.push({ type: "text", text: (m[5] ?? m[6])!, styles: { italic: true } });
    else runs.push({ type: "text", text: m[7]!, styles: { code: true } });
    last = (m.index ?? 0) + m[0].length;
  }
  plain(text.slice(last));
  return runs;
}

interface Parsed {
  title: string;
  blocks: unknown[];
}

/** The `key: value` lines between two `---` lines at the top of a file, and the rest of the text. */
export function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!m) return { meta: {}, body: source };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return { meta, body: source.slice(m[0].length) };
}

/** The blocks of Markdown text; the first level-one heading is taken out and returned as the title. */
export function markdownToBlocks(markdown: string): Parsed {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: unknown[] = [];
  let title = "";
  let n = 0;
  const id = () => `md${++n}`;
  const block = (type: string, props: Record<string, unknown>, content: unknown) => ({
    id: id(),
    type,
    props,
    content,
    children: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = /^\s*```\s*([\w#+.-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      blocks.push(
        block("codeBlock", { language: fence[1] || "plaintext" }, [
          { type: "text", text: code.join("\n"), styles: {} },
        ]),
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (level === 1 && title === "" && blocks.length === 0) title = heading[2]!;
      else blocks.push(block("heading", { level }, inlineRuns(heading[2]!)));
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(block("divider", {}, null));
      i++;
      continue;
    }
    const picture = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(line);
    if (picture) {
      blocks.push(block("image", { src: picture[2]!, alt: picture[1]! }, null));
      i++;
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (item) {
      const type = item[3] !== undefined ? "taskList" : item[1] ? "bulletList" : "numberedList";
      blocks.push(
        block(
          type,
          item[3] !== undefined ? { checked: item[3] !== " " } : {},
          inlineRuns(item[4]!),
        ),
      );
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!))
        quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push(block("quote", {}, inlineRuns(quote.join(" ").trim())));
      continue;
    }
    // A paragraph: lines up to a blank line or the start of another kind of block.
    const text: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]!)
    )
      text.push(lines[i++]!.trim());
    if (text.length === 0) {
      text.push(lines[i++]!.trim());
    }
    blocks.push(block("paragraph", {}, inlineRuns(text.join(" "))));
  }
  return { title, blocks };
}

export interface MarkdownFile {
  name: string;
  text: string;
}

/**
 * Imports Markdown files, one page or post each. A block of `key: value` lines between two `---` lines at the top may give
 * `title`, `slug`, `type` and `status`; without a title, the first `# heading` or else the file's name is used. Pictures are
 * not downloaded: the address is kept as written, and a picture with no description keeps a page from going live.
 */
export async function importPagesFromMarkdown(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  files: MarkdownFile[],
  defaultType = "page",
  now: () => number = Date.now,
): Promise<ImportResult> {
  if (files.length === 0)
    return { ok: false, code: "invalid", message: "Choose at least one file." };
  if (files.length > MAX_MARKDOWN_FILES)
    return {
      ok: false,
      code: "invalid",
      message: `That is ${files.length} files. At most ${MAX_MARKDOWN_FILES} can be imported at once.`,
    };
  if (files.reduce((sum, f) => sum + f.text.length, 0) > MAX_IMPORT_CHARS)
    return { ok: false, code: "invalid", message: "The files are too big together." };
  const rows: ImportRow[] = [];
  const tooBig: ImportReport["items"] = [];
  files.forEach((file, index) => {
    if (file.text.length > MAX_MARKDOWN_FILE_CHARS) {
      tooBig.push({
        row: index + 1,
        name: file.name,
        title: file.name,
        outcome: "skipped",
        note: `The file is too big. It can be at most ${Math.round(MAX_MARKDOWN_FILE_CHARS / 1000)} KB.`,
      });
      return;
    }
    const { meta, body } = frontMatter(file.text);
    const parsed = markdownToBlocks(body);
    rows.push({
      number: index + 1,
      name: file.name,
      title: (
        meta["title"] ||
        parsed.title ||
        file.name.replace(/\.[A-Za-z0-9]+$/, "").replace(/[-_]+/g, " ")
      ).trim(),
      slug: meta["slug"] ?? "",
      type: (meta["type"] || defaultType).toLowerCase(),
      status: meta["status"] ?? "",
      blocks: parsed.blocks,
    });
  });
  const report = await importRows(runner, actor, siteId, rows, "markdown", now);
  report.skipped += tooBig.length;
  report.items.push(...tooBig);
  report.items.sort((a, b) => a.row - b.row);
  return { ok: true, ...report };
}
