// Settings > Screen sizes (spec 06, section 4.1): which of the seven screen sizes the site designs for. "base" (the smallest
// screen) is always on; the default is phone, tablet and desktop. The list decides which sizes the layout editor shows, which
// styles a saved page keeps, and which the public pages draw. A style written for a size that is switched off is kept in the
// page until it is saved again, so switching a size back on brings it back.
import { BREAKPOINTS, DEFAULT_BREAKPOINTS } from "@oks-page/content-safety";
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const SCREEN_SIZES_KEY = "screen-sizes";

/** The names of the screen sizes that are on, smallest first. "base" is always there. */
export function readScreenSizes(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { sizes?: unknown }).sizes)
      ? (raw as { sizes: unknown[] }).sizes
      : null;
  if (!list) return [...DEFAULT_BREAKPOINTS];
  const on = new Set(list.filter((x): x is string => typeof x === "string"));
  return BREAKPOINTS.filter((b) => b.name === "base" || on.has(b.name)).map((b) => b.name);
}

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export async function loadScreenSizes(runner: SqlRunner, siteId: string): Promise<string[]> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, SCREEN_SIZES_KEY],
  );
  return readScreenSizes(decode(runner, rows[0]?.["value"]));
}

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

/** Saves the screen sizes. Only people who manage the settings; only known sizes; "base" is always kept. */
export async function saveScreenSizes(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: { sizes?: unknown },
): Promise<{ ok: true; sizes: string[] } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (!Array.isArray(input.sizes))
    return { ok: false, code: "invalid", message: "Choose the screen sizes.", field: "sizes" };
  const known = new Set<string>(BREAKPOINTS.map((b) => b.name));
  if (!input.sizes.every((s) => typeof s === "string" && known.has(s)))
    return {
      ok: false,
      code: "invalid",
      message: "One of the screen sizes is not known.",
      field: "sizes",
    };
  const sizes = readScreenSizes(input.sizes);
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, SCREEN_SIZES_KEY, JSON.stringify({ sizes }), new Date()],
  );
  return { ok: true, sizes };
}
