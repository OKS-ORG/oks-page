// A theme's sample pages (spec 05, section 17.3): added only when the owner ticks the box, only as drafts, and never over
// a page that exists (each one gets its own new address). The person who adds them needs to be allowed to add that kind of
// page; a page they may not add is left out. Every page goes through the same block checks as any save.
import type { SqlRunner } from "@oks-page/db";
import { createDraft, saveContent, type Actor } from "./content.js";
import type { ThemeLayout } from "./theme-package.js";

/** Adds the sample pages as drafts and returns how many were added. */
export async function addStarterPages(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  pages: ThemeLayout[],
): Promise<number> {
  let added = 0;
  for (const page of pages) {
    const type = page.type === "post" ? "post" : "page";
    const made = await createDraft(runner, actor, siteId, { type, title: page.title });
    if (!made.ok) continue;
    const saved = await saveContent(runner, actor, siteId, made.id, {
      title: page.title,
      slugPart: made.slug.slice(made.slug.lastIndexOf("/") + 1),
      status: "draft",
      blocks: page.blocks,
      revision: made.revision,
    });
    if (saved.ok) added++;
  }
  return added;
}
