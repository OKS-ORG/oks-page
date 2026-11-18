// The style sheet of one page (spec 06, section 4.3): the CSS for the responsive styles of its blocks, as a file the page
// links to, so a page needs no inline style. The name carries the first 16 letters of the text's SHA-256, so while a
// name matches the page's CSS the file never changes.
import { createHash } from "node:crypto";
import type { Block } from "@oks-page/content-safety";
import { pageCss } from "@oks-page/renderer";
import type { SqlRunner } from "@oks-page/db";

export const pageStyleName = (css: string): string =>
  `${createHash("sha256").update(css).digest("hex").slice(0, 16)}.css`;

/** The CSS of a stored page body (`{ blocks }`, or the block list itself). Empty when no block has a style. */
export function pageCssOfBody(body: unknown, enabled?: readonly string[]): string {
  const blocks = Array.isArray(body)
    ? body
    : body !== null &&
        typeof body === "object" &&
        Array.isArray((body as { blocks?: unknown }).blocks)
      ? (body as { blocks: unknown[] }).blocks
      : [];
  return pageCss(blocks as Block[], enabled);
}

/** The address of the page's style file, or null when the page has no styled block. */
export const pageStyleUrl = (entryId: string, css: string): string | null =>
  css ? `/page-style/${entryId}/${pageStyleName(css)}` : null;

/** The CSS of a published page, read from its body. */
export async function loadPageCss(
  runner: SqlRunner,
  siteId: string,
  entryId: string,
): Promise<string> {
  const rows = await runner.all(
    `select "body" from "entries" where "id" = ? and "site_id" = ? and "status" = 'published'`,
    [entryId, siteId],
  );
  const raw = rows[0]?.["body"];
  if (raw == null) return "";
  try {
    return pageCssOfBody(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch {
    return "";
  }
}
