// The publish check (spec 03, section 8, point 5): before a page or post goes live, what is missing that a reader would
// notice: a title, any content, and the description of each picture. The editor shows the list; an administrator may
// publish anyway, and that is written to the audit log. Advice about style (skipped headings, vague links) stays in the
// editor's own checker and never blocks. Pure except for the audit write.
import { checkBlocks, type Block } from "@oks-page/content-safety";
import { newId, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export interface PublishProblem {
  rule: "missing-title" | "empty-body" | "missing-alt";
  message: string;
}

/** Blocks that are content on their own, without text. */
const NOT_TEXT = new Set([
  "image",
  "video",
  "embed",
  "table",
  "file",
  "bookmark",
  "linked-section",
  "codeBlock",
]);

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((item) =>
          item && typeof item === "object" ? String((item as { text?: unknown }).text ?? "") : "",
        )
        .join("")
    : "";

function hasContent(blocks: Block[]): boolean {
  return blocks.some(
    (b) =>
      NOT_TEXT.has(b.type) ||
      textOf(b.content).trim() !== "" ||
      // A button keeps its words in its settings, not in text content.
      (b.type === "button" &&
        typeof b.props["text"] === "string" &&
        b.props["text"].trim() !== "") ||
      (b.type !== "divider" && hasContent(b.children)),
  );
}

function pictures(blocks: Block[], into: Block[] = []): Block[] {
  for (const b of blocks) {
    if (b.type === "image") into.push(b);
    pictures(b.children, into);
  }
  return into;
}

/** What is missing before this goes live. Empty when it is fine. */
export function publishProblems(title: string, rawBlocks: unknown): PublishProblem[] {
  const blocks = checkBlocks({ version: 1, blocks: rawBlocks }).body.blocks;
  const problems: PublishProblem[] = [];
  if (title.trim() === "")
    problems.push({ rule: "missing-title", message: "It has no title. Give it one." });
  if (!hasContent(blocks))
    problems.push({
      rule: "empty-body",
      message: "It has no content yet. Write something, or keep it as a draft.",
    });
  pictures(blocks).forEach((picture, i) => {
    if (picture.props["decorative"] === true) return;
    if (typeof picture.props["alt"] === "string" && picture.props["alt"].trim() !== "") return;
    problems.push({
      rule: "missing-alt",
      message: `Picture ${i + 1} has no description. Add one, for people who cannot see it.`,
    });
  });
  return problems;
}

/** Whether this person may publish although the check found problems (administrators). */
export const mayPublishAnyway = (actor: Actor): boolean => actor.can("settings.manage");

/** Writes the override to the audit log: who published what, and which problems were set aside. */
export async function recordPublishOverride(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  entryId: string,
  problems: PublishProblem[],
  now: number = Date.now(),
): Promise<void> {
  await runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id",
      "detail", "created_at") values (?, ?, 'user', ?, 'entry.publish_anyway', 'entry', ?, ?, ?)`,
    [
      newId(),
      siteId,
      actor.userId,
      entryId,
      JSON.stringify({ problems: problems.map((p) => p.rule) }),
      new Date(now),
    ],
  );
}
