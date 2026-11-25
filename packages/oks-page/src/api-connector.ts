// /api/oks/v1/<action> (spec 11, section 6): how this site answers an agency's dashboard. Every request must be signed with one
// of this site's connection keys (see core connector.ts). The actions are a fixed list: `status` and `report` (GET) answer;
// `backup` (POST) makes a backup of the site now (at most one in ten minutes); `update` (POST) is not built yet and says so.
// Both come after the signature has passed. Anything else is 404, again only after
// the signature has passed. Without a key the connection is off and nothing is answered.
import {
  connectorKeys,
  connectorReport,
  connectorStatus,
  emailWorks,
  BODY_MAX_BYTES,
  lastGoodBackup,
  listBackupFiles,
  listMembers,
  loadPrivacySettings,
  NonceStore,
  runBackup,
  verifyRequest,
} from "@oks-page/core";
import { statfs } from "node:fs/promises";
import { NextResponse } from "next/server";
import { backupContext } from "./backup-context";
import { getRunner, getSiteId } from "./db";
import { siteSecrets } from "./mail";

const HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const answer = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: HEADERS });

/** Whether a backup asked for by the dashboard is running (in this process). */
let backingUp = false;

/** The nonces used lately (in this process only). */
const nonces = new NonceStore();

type Context = { params: Promise<{ action: string }> };

async function diskFree(): Promise<number | null> {
  try {
    const s = await statfs(process.cwd());
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function handle(request: Request, context: Context, method: "GET" | "POST") {
  const { action } = await context.params;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > BODY_MAX_BYTES)
    return answer(413, { ok: false, code: "too_large", message: "The request is too large." });
  const body = new Uint8Array(await request.arrayBuffer());
  let siteId: string;
  try {
    siteId = await getSiteId();
  } catch {
    return answer(404, { ok: false, code: "off", message: "This site is not set up yet." });
  }
  const runner = getRunner();
  const keys = await connectorKeys(runner, siteId, siteSecrets());
  if (keys.length === 0)
    return answer(404, { ok: false, code: "off", message: "The connection is not switched on." });
  const url = new URL(request.url);
  const verified = verifyRequest({
    method: request.method,
    target: url.pathname + url.search,
    headers: (name) => request.headers.get(name),
    body,
    keys,
    nonces,
    now: Date.now(),
  });
  if (!verified.ok)
    return answer(verified.status, { ok: false, code: verified.code, message: verified.message });

  const known = ["status", "report", "backup", "update"];
  if (!known.includes(action))
    return answer(404, { ok: false, code: "unknown_action", message: "There is no such action." });
  const wants = action === "status" || action === "report" ? "GET" : "POST";
  if (method !== wants)
    return answer(405, { ok: false, code: "method", message: `This action uses ${wants}.` });
  const now = Date.now();
  if (action === "status") {
    const admins = (await listMembers(runner, siteId)).filter((m) => m.roleKey === "administrator");
    const status = await connectorStatus(
      runner,
      siteId,
      {
        version: process.env["OKS_VERSION"] ?? "",
        twoFactor: { on: admins.filter((a) => a.twoFactor).length, total: admins.length },
        emailWorks: await emailWorks(runner, siteId),
        privacyPage: (await loadPrivacySettings(runner, siteId)).pageId !== null,
        diskFreeBytes: await diskFree(),
        lastBackupAt: (await lastGoodBackup(backupContext()))?.createdAt ?? null,
      },
      now,
    );
    return answer(200, { ok: true, ...status });
  }
  if (action === "report") {
    const asked = Number(url.searchParams.get("days") ?? "30");
    const days = Number.isInteger(asked) && asked >= 1 && asked <= 90 ? asked : 30;
    return answer(200, { ok: true, ...(await connectorReport(runner, siteId, now, days)) });
  }
  if (action === "backup") {
    const ctx = backupContext();
    // One at a time, and not again within ten minutes: a backup is heavy, and a dashboard that asks twice does not need two.
    if (backingUp)
      return answer(429, {
        ok: false,
        code: "too_soon",
        message: "A backup is being made right now.",
      });
    const recent = (await listBackupFiles(ctx)).find((b) => b.kind === "remote");
    if (recent && now - recent.createdAt < 10 * 60 * 1000)
      return answer(429, {
        ok: false,
        code: "too_soon",
        message: "A backup was made a few minutes ago. Wait ten minutes before asking for another.",
      });
    backingUp = true;
    try {
      const made = await runBackup(runner, ctx, "remote");
      if (!made.ok) return answer(500, { ok: false, code: "failed", message: made.message });
      const { createdAt, size, rows, files, checkedAt } = made.info;
      return answer(200, { ok: true, createdAt, size, rows, files, checkedAt });
    } finally {
      backingUp = false;
    }
  }
  return answer(501, {
    ok: false,
    code: "not_available",
    message: "Remote updates are not built yet. Update the site on the site itself.",
  });
}

export const GET = (request: Request, context: Context) => handle(request, context, "GET");
export const POST = (request: Request, context: Context) => handle(request, context, "POST");
