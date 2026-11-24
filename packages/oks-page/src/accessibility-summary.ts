// What the accessibility checker finds across the whole site, for the accessibility statement draft (spec 18, section 4). It
// reads the published pages and posts with the same checker the editor uses, and only counts: nothing is changed.
import type { AccessibilityFinding } from "@oks-page/core";
import type { SqlRunner } from "@oks-page/db";
import { checkAccessibility, type AccessibilityRule, type CheckedBlock } from "./accessibility";

const LABEL: Record<AccessibilityRule, string> = {
  "missing-alt": "Pictures without a description",
  "skipped-heading": "Skipped heading levels",
  "empty-link": "Links with no text",
  "vague-link": "Links whose text does not say where they go",
  "table-header": "Tables without a header row",
  "low-contrast": "Text that is hard to read against its background",
  "long-paragraph": "Very long paragraphs",
};

/** The most pages of one kind of problem that are named in the statement. */
const NAMED = 3;
/** The most entries read, so a very large site cannot make this slow. */
const MOST_ENTRIES = 2000;

const blocksOf = (raw: unknown): CheckedBlock[] => {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (Array.isArray(v)) return v as CheckedBlock[];
  const inner = (v as { blocks?: unknown } | null)?.blocks;
  return Array.isArray(inner) ? (inner as CheckedBlock[]) : [];
};

export interface AccessibilitySummary {
  pagesChecked: number;
  findings: AccessibilityFinding[];
}

export async function summariseAccessibility(
  runner: SqlRunner,
  siteId: string,
): Promise<AccessibilitySummary> {
  const rows = await runner.all(
    `select "title", "body" from "entries" where "site_id" = ? and "status" = 'published'
      and "type_key" in ('page', 'post') order by "title" limit ${MOST_ENTRIES}`,
    [siteId],
  );
  const found = new Map<AccessibilityRule, { count: number; pages: string[] }>();
  for (const row of rows) {
    const title = String(row["title"] ?? "");
    for (const issue of checkAccessibility(blocksOf(row["body"]))) {
      const f = found.get(issue.rule) ?? { count: 0, pages: [] };
      f.count += 1;
      if (f.pages.length < NAMED && !f.pages.includes(title)) f.pages.push(title);
      found.set(issue.rule, f);
    }
  }
  return {
    pagesChecked: rows.length,
    findings: (Object.keys(LABEL) as AccessibilityRule[])
      .filter((r) => found.has(r))
      .map((r) => ({ label: LABEL[r], ...found.get(r)! })),
  };
}

/** A day as the statement writes it ("24 November 2026"). */
export const statementDate = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
