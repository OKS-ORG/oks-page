// Tools > Publish: sends the exported site (the folder `oks export` made) to a place the owner saved. One publish runs at a
// time; it carries on after the request that started it, and the screen asks how it is going. The result of each place's
// last publish is kept, so it is still there after a restart.
import {
  folderTarget,
  publishSite,
  recordPublishLast,
  secretPlace,
  sftpTarget,
  zipTarget,
  type PublishTarget,
  type PublishTargetConfig,
} from "@oks-page/core";
import type { SqlRunner } from "@oks-page/db";
import { existsSync } from "node:fs";
import path from "node:path";
import { siteSecrets } from "./mail";

export interface Running {
  targetId: string;
  startedAt: number;
  /** How many steps (files sent or removed) are done. */
  steps: number;
}

const shared = globalThis as typeof globalThis & { __oksPublish?: { running: Running | null } };
const state = (shared.__oksPublish ??= { running: null });

/** The exported site: `out` in the project, or the folder in OKS_EXPORT_DIR. */
export const exportFolder = (): string =>
  path.resolve(process.env["OKS_EXPORT_DIR"] ?? path.join(process.cwd(), "out"));

/** Where a zip file is written: the project's own `publish` folder, or the folder in OKS_PUBLISH_DIR. */
export const zipFolder = (): string =>
  path.resolve(process.env["OKS_PUBLISH_DIR"] ?? path.join(process.cwd(), "publish"));

export const exportReady = (): boolean => existsSync(path.join(exportFolder(), "index.html"));

export function publishRunning(): Running | null {
  return state.running ? { ...state.running } : null;
}

function targetFor(config: PublishTargetConfig): PublishTarget {
  if (config.kind === "zip") return zipTarget(path.join(zipFolder(), config.path));
  if (config.kind === "sftp" && config.sftp) {
    // The sealed secrets are opened only now, for this publish, and only in memory.
    const box = siteSecrets();
    const open = (name: "password" | "privateKey" | "passphrase") => {
      const sealed = config.secrets?.[name];
      return sealed ? box.open(sealed, secretPlace(config.id, name)) : undefined;
    };
    const password = open("password");
    const privateKey = open("privateKey");
    const passphrase = open("passphrase");
    return sftpTarget({
      host: config.sftp.host,
      port: config.sftp.port,
      username: config.sftp.username,
      remoteDir: config.path,
      hostKey: config.sftp.hostKey,
      ...(password !== undefined ? { password } : {}),
      ...(privateKey !== undefined ? { privateKey } : {}),
      ...(passphrase !== undefined ? { passphrase } : {}),
    });
  }
  return folderTarget(config.path);
}

/** Starts a publish to one saved place. It answers at once; the work goes on in the background. */
export function startPublish(
  runner: SqlRunner,
  siteId: string,
  config: PublishTargetConfig,
): { ok: true } | { ok: false; message: string } {
  if (state.running)
    return { ok: false, message: "A publish is already running. Wait until it is done." };
  if (!exportReady())
    return {
      ok: false,
      message: `There is no exported site in ${exportFolder()}. Make one with "oks export" first.`,
    };
  const running: Running = { targetId: config.id, startedAt: Date.now(), steps: 0 };
  state.running = running;
  void (async () => {
    let ok = false;
    let message: string;
    try {
      const report = await publishSite(exportFolder(), targetFor(config), {
        onStep: () => {
          running.steps++;
        },
      });
      ok = report.ok;
      if (report.ok) {
        const sent = report.done.filter((o) => o.kind === "put").length;
        const removed = report.done.length - sent;
        message =
          report.planned === 0
            ? "Nothing changed: the place already has this site."
            : `Published: ${sent} file${sent === 1 ? "" : "s"} sent, ${removed} removed.`;
      } else
        message = `${report.problem ?? "The publish stopped."} (${report.done.length} of ${report.planned} steps were done; the place still works as it was.)`;
    } catch (error) {
      message = `The publish stopped: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      await recordPublishLast(runner, siteId, config.id, { at: Date.now(), ok, message });
    } finally {
      state.running = null;
    }
  })();
  return { ok: true };
}
