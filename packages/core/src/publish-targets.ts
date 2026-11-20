// Where the owner publishes an exported site to (spec 10, section 7.2; the Publish screen). A target is kept in the site's
// `settings` table under the key `publish-targets`; the result of the last publish to each is kept under `publish-last`.
// Nothing secret is kept here: a target that needs a password or a token keeps it sealed (a later piece of work).
import { newId, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const PUBLISH_TARGETS_KEY = "publish-targets";
export const PUBLISH_LAST_KEY = "publish-last";
export const MAX_PUBLISH_TARGETS = 10;

export const PUBLISH_KINDS = ["folder", "zip"] as const;
export type PublishKind = (typeof PUBLISH_KINDS)[number];

export interface PublishTargetConfig {
  id: string;
  kind: PublishKind;
  /** The name the owner gave it: "Client's server". */
  label: string;
  /** A folder (an absolute path), or the zip file (a path ending in `.zip`, relative to the project's `publish` folder). */
  path: string;
}

export interface PublishLast {
  at: number;
  ok: boolean;
  /** One plain sentence: what was sent, or what went wrong. */
  message: string;
}

export type PublishResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };

const fail = (code: "forbidden" | "invalid" | "not_found", message: string) =>
  ({ ok: false, code, message }) as const;

const parse = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

async function load(runner: SqlRunner, siteId: string, key: string): Promise<unknown> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  return parse(rows[0]?.["value"]);
}

async function store(
  runner: SqlRunner,
  siteId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date()],
  );
}

/** A saved list, with anything that is not a valid target left out. */
export function readTargets(raw: unknown): PublishTargetConfig[] {
  const list = Array.isArray(parse(raw)) ? (parse(raw) as unknown[]) : [];
  const out: PublishTargetConfig[] = [];
  for (const item of list) {
    const t = item as Record<string, unknown> | null;
    if (
      t &&
      typeof t["id"] === "string" &&
      (PUBLISH_KINDS as readonly string[]).includes(String(t["kind"])) &&
      typeof t["label"] === "string" &&
      typeof t["path"] === "string"
    )
      out.push({
        id: t["id"],
        kind: t["kind"] as PublishKind,
        label: t["label"],
        path: t["path"],
      });
  }
  return out.slice(0, MAX_PUBLISH_TARGETS);
}

export async function listPublishTargets(
  runner: SqlRunner,
  siteId: string,
): Promise<PublishTargetConfig[]> {
  return readTargets(await load(runner, siteId, PUBLISH_TARGETS_KEY));
}

/** The path as it will be used, or the words for what is wrong with it. */
export function cleanTargetPath(
  kind: PublishKind,
  raw: string,
): { path: string } | { problem: string } {
  const path = raw.trim();
  if (path === "" || path.length > 500 || path.includes("\0"))
    return { problem: "Give the place a path of at most 500 characters." };
  if (kind === "folder") {
    // An absolute path on this computer: a Unix path, or a drive letter on Windows. Never the root itself.
    const unix = /^\/(?!\/)[^]*$/.test(path) && path !== "/";
    const windows = /^[A-Za-z]:[\\/][^]+$/.test(path);
    if (!unix && !windows)
      return {
        problem:
          "A folder needs the whole path, such as /var/www/site (not the main folder of the drive).",
      };
    if (path.split(/[\\/]/).includes("..")) return { problem: 'The path may not contain "..".' };
    return { path };
  }
  // A zip file is written in the project's own `publish` folder: only its name is chosen.
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}\.zip$/.test(path))
    return { problem: "The zip file needs a plain name ending in .zip, such as site.zip." };
  return { path };
}

/** Adds a target, or changes the one with this id. */
export async function savePublishTarget(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: { id?: unknown; kind?: unknown; label?: unknown; path?: unknown },
): Promise<PublishResult<{ target: PublishTargetConfig }>> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not change the settings.");
  const kind = String(input.kind ?? "");
  if (!(PUBLISH_KINDS as readonly string[]).includes(kind))
    return fail("invalid", "Choose a folder or a zip file.");
  const label = String(input.label ?? "").trim();
  if (label === "" || label.length > 60)
    return fail("invalid", "Give it a name of at most 60 characters.");
  const cleaned = cleanTargetPath(kind as PublishKind, String(input.path ?? ""));
  if ("problem" in cleaned) return fail("invalid", cleaned.problem);
  const all = await listPublishTargets(runner, siteId);
  const id = typeof input.id === "string" && input.id !== "" ? input.id : null;
  if (id && !all.some((t) => t.id === id)) return fail("not_found", "This place does not exist.");
  if (!id && all.length >= MAX_PUBLISH_TARGETS)
    return fail("invalid", `A site can have at most ${MAX_PUBLISH_TARGETS} places to publish to.`);
  const target: PublishTargetConfig = {
    id: id ?? newId(),
    kind: kind as PublishKind,
    label,
    path: cleaned.path,
  };
  await store(
    runner,
    siteId,
    PUBLISH_TARGETS_KEY,
    id ? all.map((t) => (t.id === id ? target : t)) : [...all, target],
  );
  return { ok: true, target };
}

export async function deletePublishTarget(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<PublishResult<object>> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not change the settings.");
  const all = await listPublishTargets(runner, siteId);
  if (!all.some((t) => t.id === id)) return fail("not_found", "This place does not exist.");
  await store(
    runner,
    siteId,
    PUBLISH_TARGETS_KEY,
    all.filter((t) => t.id !== id),
  );
  const last = await loadPublishLast(runner, siteId);
  if (id in last) {
    delete last[id];
    await store(runner, siteId, PUBLISH_LAST_KEY, last);
  }
  return { ok: true };
}

/** What the last publish to each place did, by the place's id. */
export async function loadPublishLast(
  runner: SqlRunner,
  siteId: string,
): Promise<Record<string, PublishLast>> {
  const raw = await load(runner, siteId, PUBLISH_LAST_KEY);
  const out: Record<string, PublishLast> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const r = v as Record<string, unknown> | null;
      if (
        r &&
        typeof r["at"] === "number" &&
        typeof r["ok"] === "boolean" &&
        typeof r["message"] === "string"
      )
        out[id] = { at: r["at"], ok: r["ok"], message: r["message"].slice(0, 500) };
    }
  return out;
}

export async function recordPublishLast(
  runner: SqlRunner,
  siteId: string,
  id: string,
  result: PublishLast,
): Promise<void> {
  const last = await loadPublishLast(runner, siteId);
  last[id] = { ...result, message: result.message.slice(0, 500) };
  await store(runner, siteId, PUBLISH_LAST_KEY, last);
}
