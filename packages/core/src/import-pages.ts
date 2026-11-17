// Importing pages and posts (spec 03, section 9): from a CSV file (one row is one page or post) or from Markdown files
// (one file is one page or post). Every one goes through the same paths as a page made in the editor: it is created as a
// draft and saved with the block checks, and one that asks to be published goes through the publish check (pull request
// 102), so an import can never put an empty page or a picture with no description on the site. One that does not pass
// is kept as a draft, with the reason in the report.
import { newId, type SqlRunner } from "@oks-page/db";
import { createDraft, saveContent, type Actor } from "./content.js";
import { publishProblems } from "./publish-check.js";

export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_CHARS = 1_000_000;

/** CSV text into rows of cells: quotes, doubled quotes, new lines inside quotes, a byte-order mark, `,` or `;`. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const delimiter = firstLine.includes(",") || !firstLine.includes(";") ? "," : ";";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface ImportItem {
  /** The row's number in the file (the header is row 1), or the file's number in a Markdown import. */
  row: number;
  /** The file's name, for a Markdown import. */
  name?: string;
  title: string;
  outcome: "created" | "skipped";
  /** What it is now: "published" or "draft". */
  status?: "published" | "draft";
  id?: string;
  slug?: string;
  /** Why it is not what was asked for, in plain words. */
  note?: string;
}

export interface ImportReport {
  created: number;
  published: number;
  /** Ones that asked to be published and were kept as drafts. */
  keptAsDrafts: number;
  skipped: number;
  items: ImportItem[];
}

export type ImportResult =
  ({ ok: true } & ImportReport) | { ok: false; code: "forbidden" | "invalid"; message: string };

/** One page or post to import, whatever file it came from. */
export interface ImportRow {
  number: number;
  name?: string;
  title: string;
  slug: string;
  type: string;
  /** What the file says: "draft", "published" or something else (a draft, with a note). */
  status: string;
  blocks: unknown[];
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Creates every row through the editor's paths and writes the report and the audit line. */
export async function importRows(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  rows: ImportRow[],
  source: "csv" | "markdown",
  now: () => number = Date.now,
): Promise<ImportReport> {
  const mayPublish = (type: string) =>
    actor.can("content.publish_any", type) || actor.can("content.publish_own", type);
  const report: ImportReport = { created: 0, published: 0, keptAsDrafts: 0, skipped: 0, items: [] };
  for (const item of rows) {
    const { title, type, blocks } = item;
    const label = { row: item.number, ...(item.name ? { name: item.name } : {}), title };
    const skip = (note: string) => {
      report.skipped++;
      report.items.push({ ...label, outcome: "skipped", note });
    };
    if (!title) {
      skip("It has no title.");
      continue;
    }
    const made = await createDraft(runner, actor, siteId, { type, title }, now);
    if (!made.ok) {
      skip(made.message);
      continue;
    }
    const notes: string[] = [];
    let status: "published" | "draft" = "draft";
    const wanted = item.status.trim().toLowerCase();
    if (wanted === "published") {
      const problems = publishProblems(title, blocks);
      if (!mayPublish(type))
        notes.push("You may not publish this kind of content, so it is a draft.");
      else if (problems.length > 0) {
        notes.push(`Kept as a draft. ${problems.map((p) => p.message).join(" ")}`);
        report.keptAsDrafts++;
      } else status = "published";
    } else if (wanted !== "" && wanted !== "draft")
      notes.push(`"${item.status.trim()}" is not a status, so it is a draft.`);

    const given = item.slug.trim().toLowerCase();
    const madePart = made.slug.slice(made.slug.lastIndexOf("/") + 1);
    const wantedPart = given !== "" && SLUG.test(given) ? given : madePart;
    if (given !== "" && wantedPart !== given)
      notes.push("The address was not usable, so one was made from the title.");
    const save = (slugPart: string) =>
      saveContent(
        runner,
        actor,
        siteId,
        made.id,
        { title, slugPart, status, scheduledAt: null, blocks, revision: made.revision },
        now,
      );
    let saved = await save(wantedPart);
    if (!saved.ok && saved.code === "slug_taken" && wantedPart !== madePart) {
      notes.push("The address is already used, so one was made from the title.");
      saved = await save(madePart);
    }
    report.created++;
    if (!saved.ok) {
      report.items.push({
        ...label,
        outcome: "created",
        status: "draft",
        id: made.id,
        slug: made.slug,
        note: `Saved as an empty draft: ${saved.message}`,
      });
      continue;
    }
    if (status === "published") report.published++;
    report.items.push({
      ...label,
      outcome: "created",
      status,
      id: made.id,
      slug: saved.slug,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    });
  }
  await runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id",
      "detail", "created_at") values (?, ?, 'user', ?, 'content.import', 'site', ?, ?, ?)`,
    [
      newId(),
      siteId,
      actor.userId,
      siteId,
      JSON.stringify({
        source,
        created: report.created,
        published: report.published,
        keptAsDrafts: report.keptAsDrafts,
        skipped: report.skipped,
      }),
      new Date(now()),
    ],
  );
  return report;
}

const COLUMNS: Record<string, string[]> = {
  title: ["title", "name"],
  slug: ["slug", "address", "url"],
  type: ["type", "kind"],
  status: ["status"],
  content: ["content", "body", "text"],
};

/** Paragraphs from plain text: a blank line starts a new one, a single new line stays inside one. */
export function paragraphs(text: string): unknown[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s*\r?\n\s*/g, " ").trim())
    .filter((p) => p !== "")
    .map((p, i) => ({
      id: `import${i + 1}`,
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: p, styles: {} }],
      children: [],
    }));
}

/**
 * Imports the rows of a CSV file. The first row names the columns: `title` (needed), and optionally `slug`, `type`
 * (`page` or `post`, default `defaultType`), `status` (`draft` or `published`, default `draft`) and `content` (plain
 * text; a blank line starts a new paragraph). Needs the right to add each kind of content; a row that asks to be
 * published also needs the right to publish it.
 */
export async function importPagesFromCsv(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  csv: string,
  defaultType = "page",
  now: () => number = Date.now,
): Promise<ImportResult> {
  if (csv.length > MAX_IMPORT_CHARS)
    return {
      ok: false,
      code: "invalid",
      message: `The file is too big. It can be at most ${Math.round(MAX_IMPORT_CHARS / 1000)} KB.`,
    };
  const table = parseCsv(csv);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => COLUMNS[name]!.includes(h));
  if (col("title") < 0)
    return {
      ok: false,
      code: "invalid",
      message: 'The first row of the file must name the columns, and one of them must be "title".',
    };
  const rows = table.slice(1);
  if (rows.length === 0) return { ok: false, code: "invalid", message: "The file has no rows." };
  if (rows.length > MAX_IMPORT_ROWS)
    return {
      ok: false,
      code: "invalid",
      message: `The file has ${rows.length} rows. At most ${MAX_IMPORT_ROWS} can be imported at once.`,
    };
  const cell = (row: string[], name: string) => (row[col(name)] ?? "").trim();
  const items: ImportRow[] = rows.map((row, i) => ({
    number: i + 2,
    title: cell(row, "title"),
    slug: cell(row, "slug"),
    type: (cell(row, "type") || defaultType).toLowerCase(),
    status: cell(row, "status"),
    blocks: paragraphs(row[col("content")] ?? ""),
  }));
  return { ok: true, ...(await importRows(runner, actor, siteId, items, "csv", now)) };
}
