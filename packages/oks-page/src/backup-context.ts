// Where this site keeps its backups and what a backup needs from the server: the folder (the project's own `backups`, or
// OKS_BACKUP_DIR), the library's storage, a throw-away database to try a restore in, and the free space on the disk.
import { sqliteRunner } from "@oks-page/db";
import { migrateSqlite, migrationsFolder } from "@oks-page/db/migrate";
import type { BackupContext } from "@oks-page/core";
import Database from "better-sqlite3";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { mediaContext } from "./uploads";

export const backupDir = (): string =>
  path.resolve(process.env["OKS_BACKUP_DIR"] ?? path.join(process.cwd(), "backups"));

/** Free bytes where the folder is (or would be): the nearest folder that exists is asked. */
async function freeBytes(dir: string): Promise<number | null> {
  for (let at = dir; ; at = path.dirname(at)) {
    try {
      const s = await statfs(at);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      if (path.dirname(at) === at) return null;
    }
  }
}

export function backupContext(): BackupContext {
  const dir = backupDir();
  return {
    dir,
    storage: mediaContext().storage,
    openCopy: () => {
      const db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      migrateSqlite(db, migrationsFolder("sqlite"));
      return { runner: sqliteRunner(db), close: () => void db.close() };
    },
    version: process.env["OKS_VERSION"] ?? "",
    freeBytes: () => freeBytes(dir),
  };
}
