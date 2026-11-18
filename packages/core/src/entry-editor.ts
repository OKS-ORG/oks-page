// Which editor an entry opens in, and switching it (spec 06, section 13). Switching saves a revision first, so the old
// state can always be brought back; going to the writing editor says in plain words what would be lost and waits for a yes.
import {
  flattenForWriting,
  hasLock,
  LOCKED_MESSAGE,
  wrapForLayout,
} from "@oks-page/content-safety";
import type { SqlRunner } from "@oks-page/db";
import { loadForEdit, saveContent, type Actor } from "./content.js";

export type SwitchResult =
  | { ok: true; editor: "writing" | "layout"; revision: number; slug: string }
  | {
      ok: false;
      code: "forbidden" | "not_found" | "invalid" | "would_lose" | "conflict";
      message: string;
      lost?: string[];
    };

/** What switching to the writing editor would cost, in plain sentences (empty when nothing). */
export async function editorSwitchCost(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<
  { ok: true; editor: "writing" | "layout"; lost: string[] } | { ok: false; message: string }
> {
  const loaded = await loadForEdit(runner, actor, siteId, id);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  return {
    ok: true,
    editor: loaded.entry.editor,
    lost: flattenForWriting(loaded.entry.blocks).lost,
  };
}

export async function switchEditor(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  to: unknown,
  options: { anyway?: boolean } = {},
  now: () => number = Date.now,
): Promise<SwitchResult> {
  if (to !== "writing" && to !== "layout")
    return {
      ok: false,
      code: "invalid",
      message: "Choose the writing editor or the layout editor.",
    };
  const loaded = await loadForEdit(runner, actor, siteId, id);
  if (!loaded.ok)
    return {
      ok: false,
      code: loaded.code === "not_found" ? "not_found" : "forbidden",
      message: loaded.message,
    };
  const entry = loaded.entry;
  // Under a design lock only a designer may switch; the server decides, not the screen (PB-84).
  if (!actor.can("themes.manage") && hasLock(entry.blocks))
    return { ok: false, code: "forbidden", message: LOCKED_MESSAGE };
  if (entry.editor === to)
    return { ok: true, editor: to, revision: entry.revision, slug: entry.slugPart };

  let blocks = wrapForLayout(entry.blocks);
  if (to === "writing") {
    const flat = flattenForWriting(entry.blocks);
    if (flat.lost.length > 0 && options.anyway !== true)
      return {
        ok: false,
        code: "would_lose",
        message: "Switching would lose part of the layout.",
        lost: flat.lost,
      };
    blocks = flat.blocks;
  }
  const same = {
    title: entry.title,
    slugPart: entry.slugPart,
    status: entry.status,
    scheduledAt: entry.scheduledAt,
  };
  // The old state first, as a revision of its own.
  const first = await saveContent(
    runner,
    actor,
    siteId,
    id,
    { ...same, blocks: entry.blocks, revision: entry.revision },
    now,
    { summary: `Before switching to the ${to} editor` },
  );
  if (!first.ok) return { ok: false, code: "conflict", message: first.message };
  const second = await saveContent(
    runner,
    actor,
    siteId,
    id,
    { ...same, blocks, revision: first.revision },
    now,
    { summary: `Switched to the ${to} editor` },
  );
  if (!second.ok) return { ok: false, code: "conflict", message: second.message };
  const rows = await runner.all(`select "meta" from "entries" where "id" = ? and "site_id" = ?`, [
    id,
    siteId,
  ]);
  let meta: Record<string, unknown> = {};
  const raw = rows[0]?.["meta"];
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (value && typeof value === "object") meta = { ...(value as Record<string, unknown>) };
  } catch {
    // a damaged value is replaced by an empty one
  }
  if (to === "layout") meta["editor"] = "layout";
  else delete meta["editor"];
  await runner.all(`update "entries" set "meta" = ? where "id" = ? and "site_id" = ?`, [
    JSON.stringify(meta),
    id,
    siteId,
  ]);
  return { ok: true, editor: to, revision: second.revision, slug: second.slug };
}
