// Backups and restore (spec 14, part 2, sections 10 and 11; UP-20 to UP-24). A backup is one .tgz file in a folder on the server:
//   database.json   every table of the database (except what is only of the moment: who is signed in, queued jobs, caches)
//   media/<key>     every uploaded file the library keeps, with its sizes
//   manifest.json   last: the kind, the time, a fingerprint of the tables, and every file's SHA-256 and size
// Plugin and theme files live in the database, so they are in it. Secrets are in it only as the site's own sealed values: the site's
// key (OKS_SECRET) is not in the backup, so a stolen backup does not give them away, and a restore needs the same key.
//
// Each backup is checked right after it is made: every file is read again and its sum compared, and the database is put into a
// throw-away copy, as a restore would. One that does not pass is removed, not kept as a false comfort. A restore checks the file
// again first, makes a safety backup of the site as it is, and then puts the backup in place in one step, so it can be undone.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeKey, type StorageAdapter } from "@oks-page/media";
import {
  dataShape,
  exportData,
  newId,
  replaceData,
  VOLATILE_TABLES,
  type Dump,
  type SqlRunner,
} from "@oks-page/db";
import type { Actor } from "./content.js";
import { readTarGzFile, TarGzFileWriter } from "./tar.js";

export const BACKUP_KIND = "site-backup";
export const BACKUP_FORMAT = 1;
export const BACKUP_KINDS = ["manual", "safety", "daily", "remote"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];
/** The most database a check will try in a throw-away copy (a bigger one is checked by its sums only). */
export const COPY_CHECK_MAX_BYTES = 200 * 1024 * 1024;
const NAME = /^(manual|safety|daily|remote)-(\d{8})-(\d{6})-[0-9a-f]{6}\.tgz$/;

export interface BackupContext {
  /** The folder the backups are kept in. */
  dir: string;
  storage: StorageAdapter;
  /** A throw-away database (empty, every migration applied) to try a restore in. */
  openCopy: () => { runner: SqlRunner; close(): void };
  now?: () => number;
  /** The software's version, written in the backup. */
  version?: string;
  /** Free bytes on the disk of `dir`, or null when it cannot be known. */
  freeBytes?: () => Promise<number | null>;
}

export interface BackupInfo {
  name: string;
  kind: BackupKind;
  createdAt: number;
  size: number;
  /** When the check passed (the check is made right after the backup; null when it could not be read). */
  checkedAt: number | null;
  /** Rows in the database and files in the library, as the backup says. */
  rows: number;
  files: number;
  /** Whether it can be put back on this version of the software. */
  compatible: boolean;
}

type Fail = { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };
const fail = (code: Fail["code"], message: string): Fail => ({ ok: false, code, message });
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const mayManage = (actor: Actor) => actor.can("settings.manage");

interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}
interface Manifest {
  kind: string;
  format: number;
  backupKind: string;
  createdAt: number;
  version: string;
  shape: string;
  rows: number;
  files: ManifestFile[];
}

const stamp = (ms: number): string =>
  new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** The path of a backup by its name, or null when the name is not a backup's (nothing else is ever opened). */
export function backupPath(ctx: BackupContext, name: unknown): string | null {
  return typeof name === "string" && NAME.test(name) ? path.join(ctx.dir, name) : null;
}

// ------------------------------------------------------------------------------------------------------------------ checking

export type Checked =
  { ok: true; compatible: boolean; manifest: Manifest } | { ok: false; message: string };

/**
 * Reads a backup file from start to end and says whether it can be trusted: every file is where the manifest says, with the sum the
 * manifest says, nothing else is in it, and (when it fits) the database goes into a throw-away copy. Nothing is changed.
 */
export async function checkBackup(file: string, ctx: BackupContext): Promise<Checked> {
  const seen = new Map<string, ManifestFile>();
  let database: Buffer | null = null;
  let manifest: Manifest | null = null;
  try {
    for await (const entry of readTarGzFile(file)) {
      if (manifest)
        return {
          ok: false,
          message: "The backup is damaged: there is more after its list of files.",
        };
      if (entry.path === "manifest.json") {
        try {
          manifest = JSON.parse(entry.data.toString("utf8")) as Manifest;
        } catch {
          return { ok: false, message: "The backup is damaged: its list of files cannot be read." };
        }
        continue;
      }
      if (entry.path === "database.json") {
        database = entry.data;
      } else if (entry.path.startsWith("media/")) {
        try {
          assertSafeKey(entry.path.slice(6));
        } catch {
          return {
            ok: false,
            message: `The backup holds a file with a path that is not allowed: ${entry.path.slice(0, 80)}`,
          };
        }
      } else {
        return {
          ok: false,
          message: `The backup holds a file it should not: ${entry.path.slice(0, 80)}`,
        };
      }
      if (seen.has(entry.path))
        return { ok: false, message: `The backup holds ${entry.path.slice(0, 80)} twice.` };
      seen.set(entry.path, {
        path: entry.path,
        sha256: sha256(entry.data),
        size: entry.data.length,
      });
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The backup cannot be read.",
    };
  }
  if (!manifest || manifest.kind !== BACKUP_KIND)
    return { ok: false, message: "This is not a backup of a site: its list of files is missing." };
  if (typeof manifest.format !== "number" || manifest.format > BACKUP_FORMAT)
    return {
      ok: false,
      message:
        "This backup was made by a newer version. Update the software first, then restore it.",
    };
  if (!Array.isArray(manifest.files) || !database)
    return { ok: false, message: "This backup has no database in it." };
  const listed = new Set<string>();
  for (const f of manifest.files) {
    if (typeof f?.path !== "string" || typeof f.sha256 !== "string" || typeof f.size !== "number")
      return { ok: false, message: "The backup is damaged: its list of files is not right." };
    listed.add(f.path);
    const real = seen.get(f.path);
    if (!real)
      return { ok: false, message: `A file of the backup is missing: ${f.path.slice(0, 80)}` };
    if (real.sha256 !== f.sha256 || real.size !== f.size)
      return {
        ok: false,
        message: `A file of the backup has changed since it was made: ${f.path.slice(0, 80)}`,
      };
  }
  for (const p of seen.keys())
    if (!listed.has(p))
      return {
        ok: false,
        message: `The backup holds a file that is not on its list: ${p.slice(0, 80)}`,
      };

  const compatible = manifest.shape === dataShape();
  // The database, tried in a throw-away copy exactly as a restore would put it in place.
  if (compatible && database.length <= COPY_CHECK_MAX_BYTES) {
    let dump: Dump;
    try {
      dump = JSON.parse(database.toString("utf8")) as Dump;
    } catch {
      return { ok: false, message: "The database in the backup cannot be read." };
    }
    const copy = ctx.openCopy();
    try {
      await replaceData(copy.runner, dump, { keepSessions: false });
    } catch (error) {
      return {
        ok: false,
        message: `The database of the backup could not be put into a copy: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    } finally {
      copy.close();
    }
  }
  return { ok: true, compatible, manifest };
}

// ------------------------------------------------------------------------------------------------------------------ listing

interface Sidecar {
  kind: BackupKind;
  createdAt: number;
  rows: number;
  files: number;
  compatible: boolean;
  checkedAt: number | null;
}

const sidecarOf = (file: string) => `${file}.json`;

/** The backups in the folder, newest first. */
export async function listBackups(ctx: BackupContext, actor: Actor): Promise<BackupInfo[]> {
  if (!mayManage(actor)) return [];
  return listBackupFiles(ctx);
}

export async function listBackupFiles(ctx: BackupContext): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await readdir(ctx.dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    const file = path.join(ctx.dir, name);
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    const size = info.size;
    let side: Partial<Sidecar> = {};
    try {
      side = JSON.parse(await readFile(sidecarOf(file), "utf8")) as Partial<Sidecar>;
    } catch {
      // A backup without its note still lists; it just says it was not checked.
    }
    const at = Date.UTC(
      Number(m[2]!.slice(0, 4)),
      Number(m[2]!.slice(4, 6)) - 1,
      Number(m[2]!.slice(6, 8)),
      Number(m[3]!.slice(0, 2)),
      Number(m[3]!.slice(2, 4)),
      Number(m[3]!.slice(4, 6)),
    );
    out.push({
      name,
      kind: m[1] as BackupKind,
      createdAt: typeof side.createdAt === "number" ? side.createdAt : at,
      size,
      checkedAt: typeof side.checkedAt === "number" ? side.checkedAt : null,
      rows: typeof side.rows === "number" ? side.rows : 0,
      files: typeof side.files === "number" ? side.files : 0,
      compatible: side.compatible === true,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
}

export async function deleteBackup(
  ctx: BackupContext,
  actor: Actor,
  name: unknown,
): Promise<{ ok: true } | Fail> {
  if (!mayManage(actor)) return fail("forbidden", "You may not delete backups.");
  const file = backupPath(ctx, name);
  if (!file) return fail("not_found", "This backup does not exist.");
  try {
    await stat(file);
  } catch {
    return fail("not_found", "This backup does not exist.");
  }
  await rm(file, { force: true });
  await rm(sidecarOf(file), { force: true });
  return { ok: true };
}

// ----------------------------------------------------------------------------------------------------------------- keeping

export const KEEP_DAILY = 14;
export const KEEP_MONTHLY = 6;
export const KEEP_OTHER = 10;

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/** The names of the backups the keeping rules let go: the daily ones past 14 (but the newest of each of 6 months), and past 10 of any other kind. */
export function toPrune(backups: BackupInfo[]): string[] {
  const out: string[] = [];
  const newest = (a: BackupInfo, b: BackupInfo) =>
    b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1);
  const daily = backups.filter((b) => b.kind === "daily").sort(newest);
  const older = daily.slice(KEEP_DAILY);
  const monthly = new Set<string>();
  const months: string[] = [];
  for (const b of older) {
    const m = monthOf(b.createdAt);
    if (!months.includes(m)) months.push(m);
  }
  // The newest backup of each of the six latest months among the older ones is kept.
  for (const m of months.slice(0, KEEP_MONTHLY))
    monthly.add(older.find((b) => monthOf(b.createdAt) === m)!.name);
  for (const b of older) if (!monthly.has(b.name)) out.push(b.name);
  for (const kind of ["manual", "safety", "remote"] as BackupKind[])
    for (const b of backups
      .filter((x) => x.kind === kind)
      .sort(newest)
      .slice(KEEP_OTHER))
      out.push(b.name);
  return out;
}

/** Deletes the backups the keeping rules let go. The newest backup of all is never deleted. Returns how many went. */
export async function pruneBackups(ctx: BackupContext): Promise<number> {
  const all = await listBackupFiles(ctx);
  const keepAlways = all[0]?.name;
  let gone = 0;
  for (const name of toPrune(all)) {
    if (name === keepAlways) continue;
    const file = path.join(ctx.dir, name);
    await rm(file, { force: true });
    await rm(`${file}.json`, { force: true });
    gone++;
  }
  return gone;
}

// ------------------------------------------------------------------------------------------------------------------ making

/**
 * Makes a backup of the whole site into the backups folder and checks it. A backup that would not fit on the disk is refused
 * before anything is written; one that fails its check is removed and the reason given. Used by people (Tools > Backups) and by the
 * timer and the connector, which act for the site itself.
 */
export async function runBackup(
  runner: SqlRunner,
  ctx: BackupContext,
  kind: BackupKind,
): Promise<{ ok: true; info: BackupInfo } | { ok: false; message: string }> {
  const now = ctx.now ?? Date.now;
  const created = now();
  await mkdir(ctx.dir, { recursive: true, mode: 0o700 });
  const name = `${kind}-${stamp(created)}-${randomBytes(3).toString("hex")}.tgz`;
  const file = path.join(ctx.dir, name);
  const part = `${file}.part`;
  const writer = new TarGzFileWriter(part);
  try {
    const dump = await exportData(runner, { skip: VOLATILE_TABLES });
    const database = Buffer.from(JSON.stringify(dump));
    const keys: string[] = [];
    for await (const key of ctx.storage.list()) keys.push(key);
    // The disk must have room for the database and the files (a little more, for the gaps), before a byte is written.
    const library = Number(
      (
        await runner.all(
          `select coalesce((select sum("size_bytes") from "media"), 0) + coalesce((select sum("size_bytes") from "media_variants"), 0) as n`,
        )
      )[0]?.["n"] ?? 0,
    );
    const free = ctx.freeBytes ? await ctx.freeBytes() : null;
    const needed = Math.ceil((database.length + library) * 1.1) + 64 * 1024 * 1024;
    if (free !== null && free < needed) {
      writer.abort();
      await rm(part, { force: true });
      return {
        ok: false,
        message: `There is not enough free disk space for a backup (about ${Math.ceil(needed / (1024 * 1024))} MB are needed, ${Math.floor(free / (1024 * 1024))} MB are free). Free some space and try again.`,
      };
    }
    const files: ManifestFile[] = [];
    await writer.add("database.json", database);
    files.push({ path: "database.json", sha256: sha256(database), size: database.length });
    for (const key of keys) {
      try {
        assertSafeKey(key);
      } catch {
        continue;
      }
      let data: Buffer;
      try {
        data = Buffer.from(await ctx.storage.get(key));
      } catch {
        continue; // a file that vanished while the backup ran is left out, not a reason to lose the whole backup
      }
      await writer.add(`media/${key}`, data);
      files.push({ path: `media/${key}`, sha256: sha256(data), size: data.length });
    }
    const rows = Object.values(dump.tables).reduce((n, t) => n + t.length, 0);
    const manifest: Manifest = {
      kind: BACKUP_KIND,
      format: BACKUP_FORMAT,
      backupKind: kind,
      createdAt: created,
      version: ctx.version ?? "",
      shape: dataShape(),
      rows,
      files,
    };
    await writer.add("manifest.json", Buffer.from(JSON.stringify(manifest)));
    await writer.finish();
    await rename(part, file);
    // The check, as a restore would read it.
    const checked = await checkBackup(file, ctx);
    if (!checked.ok) {
      await rm(file, { force: true });
      return {
        ok: false,
        message: `The backup was made but did not pass its check, so it was removed: ${checked.message}`,
      };
    }
    const side: Sidecar = {
      kind,
      createdAt: created,
      rows,
      files: files.length - 1,
      compatible: checked.compatible,
      checkedAt: now(),
    };
    await writeFile(sidecarOf(file), JSON.stringify(side), { mode: 0o600 });
    // What the keeping rules let go is deleted now (a failure to delete never fails the backup).
    await pruneBackups(ctx).catch(() => undefined);
    return {
      ok: true,
      info: {
        name,
        kind,
        createdAt: created,
        size: (await stat(file)).size,
        checkedAt: side.checkedAt,
        rows,
        files: side.files,
        compatible: side.compatible,
      },
    };
  } catch (error) {
    writer.abort();
    await rm(part, { force: true });
    await rm(file, { force: true });
    return {
      ok: false,
      message: `The backup could not be made: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

/** A backup that a person of the site asks for. */
export async function makeBackup(
  runner: SqlRunner,
  ctx: BackupContext,
  actor: Actor,
): Promise<{ ok: true; info: BackupInfo } | Fail> {
  if (!mayManage(actor)) return fail("forbidden", "You may not make backups.");
  const made = await runBackup(runner, ctx, "manual");
  if (!made.ok) return fail("invalid", made.message);
  return made;
}

// ----------------------------------------------------------------------------------------------------------------- restoring

export interface Restored {
  rows: number;
  files: number;
  safetyBackup: string;
  /** The addresses of the pages the site had and has now, to make the public pages fresh. */
  slugs: string[];
}

/**
 * Puts the whole site back as it was at a backup. The backup is checked first; a safety backup of the site as it is comes next
 * (a restore that cannot make one does not start); the files are put back; and the database is replaced in one step, so a
 * failure leaves the site as it was. People who are still there afterwards stay signed in. Files uploaded since the backup are
 * left where they are (nothing points to them any more; the safety backup holds them).
 */
export async function restoreBackup(
  runner: SqlRunner,
  ctx: BackupContext,
  actor: Actor,
  name: unknown,
  confirm: boolean,
): Promise<({ ok: true } & Restored) | Fail> {
  if (!mayManage(actor)) return fail("forbidden", "You may not restore a backup.");
  if (!confirm)
    return fail(
      "invalid",
      "Confirm first that this puts the whole site back as it was, and replaces what is there now.",
    );
  const file = backupPath(ctx, name);
  if (!file) return fail("not_found", "This backup does not exist.");
  try {
    await stat(file);
  } catch {
    return fail("not_found", "This backup does not exist.");
  }
  const checked = await checkBackup(file, ctx);
  if (!checked.ok) return fail("invalid", `This backup cannot be restored: ${checked.message}`);
  if (!checked.compatible)
    return fail(
      "invalid",
      "This backup was made by another version of the software (its tables are not the same), so it cannot be put back here. Restore it on the version that made it.",
    );
  const oldSlugs = (await runner.all(`select "slug" from "entries"`)).map((r) => String(r["slug"]));
  const safety = await runBackup(runner, ctx, "safety");
  if (!safety.ok)
    return fail(
      "invalid",
      `Nothing was changed. The safety backup of the site as it is could not be made first: ${safety.message}`,
    );

  // The files first: a file put back that was not there is taken away again if the database cannot be replaced.
  const written: string[] = [];
  let dump: Dump | null = null;
  let filesBack = 0;
  try {
    for await (const entry of readTarGzFile(file)) {
      if (entry.path === "database.json") {
        dump = JSON.parse(entry.data.toString("utf8")) as Dump;
      } else if (entry.path.startsWith("media/")) {
        const key = entry.path.slice(6);
        if (!(await ctx.storage.exists(key))) {
          await ctx.storage.put(key, entry.data);
          written.push(key);
        }
        filesBack++;
      }
    }
    if (!dump) throw new Error("The backup has no database.");
    const result = await replaceData(runner, dump, { keepSessions: true });
    const slugs = [
      ...new Set([...oldSlugs, ...(dump.tables["entries"] ?? []).map((r) => String(r["slug"]))]),
    ];
    try {
      await runner.all(
        `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id", "detail", "created_at")
         select ?, "id", 'user', ?, 'site.restore', 'site', "id", ?, ? from "sites" limit 1`,
        [
          newId(),
          actor.userId,
          JSON.stringify({ backup: name, safetyBackup: safety.info.name }),
          new Date((ctx.now ?? Date.now)()),
        ],
      );
    } catch {
      // The line in the log is a courtesy: the actor may not exist in the restored site.
    }
    return { ok: true, rows: result.rows, files: filesBack, safetyBackup: safety.info.name, slugs };
  } catch (error) {
    for (const key of written) await ctx.storage.delete(key).catch(() => undefined);
    return fail(
      "invalid",
      `The backup could not be put back, and the site was not changed (a safety backup, ${safety.info.name}, was made first). ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }
}
