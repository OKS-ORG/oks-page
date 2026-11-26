// What Site health needs from the running server (spec 07, section 16): the certificate of the public address, the free disk, the
// secret, the mode, the administrators and the plugins. The core decides what each fact means; this file only measures. The
// certificate is read by connecting to the site's own public address (no outside service), at most once an hour.
import { connect } from "node:tls";
import { statfs } from "node:fs/promises";
import { lastGoodBackup, listMembers, runHealthChecks, type HealthReport } from "@oks-page/core";
import type { SqlRunner } from "@oks-page/db";
import { backupContext } from "./backup-context";
import { coreVersion, installedItems } from "./updates-context";
import { listPlugins } from "./plugin-admin";

const HOUR = 60 * 60 * 1000;
const state = globalThis as { __oksCert?: { url: string; at: number; days: number | null } };

/** Days until the certificate of an https address ends, or null when it cannot be read. Never throws. */
function readCertificate(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return resolve(null);
    }
    const socket = connect({
      host: target.hostname,
      port: Number(target.port) || 443,
      servername: target.hostname,
      // An expired or unknown certificate must still be read, so that it can be reported.
      rejectUnauthorized: false,
      timeout: 4000,
    });
    const done = (days: number | null) => {
      socket.destroy();
      resolve(days);
    };
    socket.once("secureConnect", () => {
      const end = Date.parse(socket.getPeerCertificate().valid_to ?? "");
      done(Number.isNaN(end) ? null : Math.floor((end - Date.now()) / (24 * HOUR)));
    });
    socket.once("timeout", () => done(null));
    socket.once("error", () => done(null));
  });
}

/** The cached reading (an hour old at most). With `probe` false the network is not touched. */
async function certificateDays(url: string | null, probe: boolean): Promise<number | null> {
  if (!url || !url.startsWith("https://")) return null;
  const cached = state.__oksCert;
  if (cached && cached.url === url && Date.now() - cached.at < HOUR) return cached.days;
  if (!probe) return cached && cached.url === url ? cached.days : null;
  const days = await readCertificate(url);
  state.__oksCert = { url, at: Date.now(), days };
  return days;
}

/** Forgets the cached certificate, so "Check again" reads it afresh. */
export function forgetCertificate(): void {
  delete state.__oksCert;
}

async function disk(): Promise<{ free: number | null; total: number | null }> {
  try {
    const s = await statfs(process.cwd());
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return { free: null, total: null };
  }
}

const EXAMPLE_SECRET = /change.?me|example|replace.?me|your.?secret|^(x+|0+|a+)$/i;

export async function currentHealth(
  runner: SqlRunner,
  siteId: string,
  options: { probe: boolean } = { probe: true },
): Promise<HealthReport> {
  const secret = process.env["OKS_SECRET"] ?? "";
  const publicUrl = process.env["OKS_SITE_URL"]?.trim() || null;
  const space = await disk();
  const admins = (await listMembers(runner, siteId)).filter((m) => m.roleKey === "administrator");
  const plugins = await listPlugins(runner, siteId);
  return runHealthChecks(runner, siteId, {
    core: coreVersion(),
    installed: await installedItems(runner, siteId),
    plugins: plugins.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    secret: { present: secret !== "", length: secret.length, example: EXAMPLE_SECRET.test(secret) },
    production: process.env["NODE_ENV"] === "production",
    publicUrl,
    certificateDaysLeft: await certificateDays(publicUrl, options.probe),
    diskFreeBytes: space.free,
    diskTotalBytes: space.total,
    admins: admins.map((a) => ({ name: a.name || a.email, twoFactor: a.twoFactor })),
    lastGoodBackupAt: (await lastGoodBackup(backupContext()))?.createdAt ?? null,
  });
}
