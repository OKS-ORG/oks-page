// The daily backup and how many are kept (spec 14, part 2, section 10; UP-21). Every day at 03:00 in the site's time zone the site makes
// a backup (a server that was off at that hour makes it when it starts), and keeps the last 14 daily ones and the newest of each of the
// last 6 months. A person's own backups, the safety backups made before a restore and the ones an agency asks for are kept apart:
// the newest 10 of each kind. A daily backup that fails is tried again an hour later, and the administrators are told once a day.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import {
  listBackupFiles,
  pruneBackups,
  runBackup,
  type BackupContext,
  type BackupInfo,
} from "./backup.js";
import { utcToZonedLocal, zonedLocalToUtc } from "./timezone.js";

export const BACKUP_SETTINGS_KEY = "backup_settings";
export const BACKUP_STATE_KEY = "backup_state";
export const BACKUP_HOUR = 3;
/** After a failed daily backup, the next try is not sooner than this. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;
/** A backup older than this is not "recent" (two days: twice the schedule). */
export const RECENT_MS = 48 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const parse = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
async function read(
  runner: SqlRunner,
  siteId: string,
  key: string,
): Promise<Record<string, unknown>> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  const v = parse(runner, rows[0]?.["value"]);
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
async function write(
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

/** Whether the daily backup is on (it is, unless the owner turned it off). */
export async function dailyBackupOn(runner: SqlRunner, siteId: string): Promise<boolean> {
  return (await read(runner, siteId, BACKUP_SETTINGS_KEY))["daily"] !== false;
}

export async function saveDailyBackupOn(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  daily: unknown,
): Promise<
  { ok: true; daily: boolean } | { ok: false; code: "forbidden" | "invalid"; message: string }
> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (typeof daily !== "boolean")
    return { ok: false, code: "invalid", message: "The request was not understood." };
  await write(runner, siteId, BACKUP_SETTINGS_KEY, { daily });
  return { ok: true, daily };
}

export interface BackupState {
  /** When the last daily backup failed and why, until one works again. */
  failedAt: number | null;
  failure: string;
  /** When the administrators were last told about a failure. */
  toldAt: number | null;
  /** When the timer last tried. */
  triedAt: number | null;
}

export async function loadBackupState(runner: SqlRunner, siteId: string): Promise<BackupState> {
  const v = await read(runner, siteId, BACKUP_STATE_KEY);
  const n = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    failedAt: n(v["failedAt"]),
    failure: typeof v["failure"] === "string" ? v["failure"] : "",
    toldAt: n(v["toldAt"]),
    triedAt: n(v["triedAt"]),
  };
}

/** The moment today's backup hour starts, on the wall clock of the zone (UTC when the site has none). */
export function dailySlotStart(
  now: number,
  zone: string | null,
  hour: number = BACKUP_HOUR,
): number {
  const z = zone ?? "UTC";
  const day = utcToZonedLocal(now, z).slice(0, 10);
  return (
    zonedLocalToUtc(`${day}T${String(hour).padStart(2, "0")}:00`, z) ??
    now - (now % DAY) + hour * 3_600_000
  );
}

/** Whether a daily backup is due: today's hour has come, and no daily backup was made since it. */
export function dailyDue(
  backups: BackupInfo[],
  now: number,
  zone: string | null,
  hour: number = BACKUP_HOUR,
): boolean {
  const slot = dailySlotStart(now, zone, hour);
  if (now < slot) return false;
  return !backups.some((b) => b.kind === "daily" && b.createdAt >= slot);
}

export interface DailyOptions {
  zone: string | null;
  hour?: number;
  now?: () => number;
  /** Called with the reason when a daily backup fails and the administrators have not been told in a day. */
  notify?: (reason: string) => Promise<void>;
}

/**
 * One look at the clock: makes the daily backup when it is due, and does nothing otherwise. After a failure it waits an hour before
 * trying again, and tells the administrators once a day. Returns what it did.
 */
export async function runDailyBackup(
  runner: SqlRunner,
  ctx: BackupContext,
  siteId: string,
  options: DailyOptions,
): Promise<"off" | "not due" | "waiting" | "made" | "failed"> {
  const now = options.now ?? ctx.now ?? Date.now;
  if (!(await dailyBackupOn(runner, siteId))) return "off";
  const existing = await listBackupFiles(ctx);
  if (!dailyDue(existing, now(), options.zone, options.hour)) return "not due";
  const state = await loadBackupState(runner, siteId);
  if (state.failedAt !== null && state.triedAt !== null && now() - state.triedAt < RETRY_AFTER_MS)
    return "waiting";
  const made = await runBackup(runner, { ...ctx, now }, "daily");
  if (made.ok) {
    await pruneBackups(ctx);
    await write(runner, siteId, BACKUP_STATE_KEY, {
      failedAt: null,
      failure: "",
      toldAt: state.toldAt,
      triedAt: now(),
    });
    return "made";
  }
  const told = state.toldAt !== null && now() - state.toldAt < DAY;
  await write(runner, siteId, BACKUP_STATE_KEY, {
    failedAt: now(),
    failure: made.message,
    toldAt: told ? state.toldAt : now(),
    triedAt: now(),
  });
  if (!told && options.notify) await options.notify(made.message).catch(() => undefined);
  return "failed";
}

/** What the screens and the connector say about backups: the newest one that passed its check. */
export async function lastGoodBackup(ctx: BackupContext): Promise<BackupInfo | null> {
  return (await listBackupFiles(ctx)).find((b) => b.checkedAt !== null) ?? null;
}
