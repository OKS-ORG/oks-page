// POST /api/csp-report: a visitor's browser says it refused a stylesheet on a public page (ADR 0038). Anyone can send
// this, so it is held to little: a small body, only a plain https host (checked like the setting), one note per host
// every few minutes and a few notes a minute in all, and it always answers the same way (204, no content).
import { recordBlockedStyle, styleReportFrom } from "@oks-page/core";
import { getRunner, getSiteId } from "./db";

const MAX_BODY = 8 * 1024;
const PER_HOST_MS = 5 * 60 * 1000;
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;
const lastNote = new Map<string, number>();
let windowStart = 0;
let inWindow = 0;

/** True when this host may be noted now; counts it when it is. Memory only: nothing about the visitor is kept. */
export function mayNote(host: string, now = Date.now()): boolean {
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    inWindow = 0;
  }
  if (inWindow >= MAX_PER_WINDOW) return false;
  const before = lastNote.get(host);
  if (before !== undefined && now - before < PER_HOST_MS) return false;
  inWindow += 1;
  lastNote.set(host, now);
  if (lastNote.size > 200)
    for (const [key, at] of lastNote) if (now - at >= PER_HOST_MS) lastNote.delete(key);
  return true;
}

/** Forgets what was counted (for tests). */
export function resetReportLimits(): void {
  lastNote.clear();
  windowStart = 0;
  inWindow = 0;
}

const done = () => new Response(null, { status: 204 });

export async function POST(request: Request) {
  try {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_BODY) return done();
    const text = await request.text();
    if (text.length > MAX_BODY) return done();
    const report = styleReportFrom(JSON.parse(text) as unknown);
    if (report && mayNote(report.host))
      await recordBlockedStyle(getRunner(), await getSiteId(), report);
  } catch {
    // A report that cannot be read or kept is simply dropped.
  }
  return done();
}
