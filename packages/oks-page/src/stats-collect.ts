// Counting a visit (spec 18, section 3), called by the public proxy when a real page is shown. Nothing is stored in the
// visitor's browser. The address and the browser's name are hashed at once, with a secret that changes every day, and only
// the hash, the page and a few coarse facts (source, country, device type) wait in memory for a moment before the daily totals
// are updated. Visitors who say "do not track", robots, prefetches and signed-in people (the owner looking at their own
// site) are not counted, and nothing is counted while the owner has switched counting off or the site has no secret.
import {
  countryOf,
  dailySecret,
  deviceOf,
  isBot,
  recordViews,
  sourceOf,
  statDayOf,
  statisticsEnabled,
  visitorHash,
  type StatView,
} from "@oks-page/core";
import { getRunner, getSiteId } from "./db";

/** How long views wait in memory before they are written (one write for many views). */
export const FLUSH_MS = 1000;
const SETTING_MS = 60_000;

interface State {
  queue: StatView[];
  siteId: string;
  timer: ReturnType<typeof setTimeout> | null;
  setting: { at: number; value: boolean } | null;
}

const state = ((globalThis as { __oksStats?: State }).__oksStats ??= {
  queue: [],
  siteId: "",
  timer: null,
  setting: null,
});

/** Forget what is known about the on/off setting (called when the owner changes it). */
export function forgetStatisticsSetting(): void {
  state.setting = null;
}

/** Writes the views that are waiting. Safe to call at any time. */
export async function flushViews(): Promise<void> {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  const batch = state.queue.splice(0);
  if (batch.length === 0) return;
  try {
    await recordViews(getRunner(), state.siteId, batch);
  } catch (error) {
    console.error("[oks] The visitor statistics could not be written:", error);
  }
}

async function enabled(siteId: string, now: number): Promise<boolean> {
  if (state.setting && now - state.setting.at < SETTING_MS) return state.setting.value;
  const value = await statisticsEnabled(getRunner(), siteId);
  state.setting = { at: now, value };
  return value;
}

/**
 * Counts a page view when it should be counted. `path` is the page's address ("/about"). Never throws, and never slows the
 * answer: the proxy does not wait for it.
 */
export async function trackView(
  request: { method: string; headers: Headers },
  path: string,
  visitor: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    const h = request.headers;
    if (request.method !== "GET") return;
    if (visitor === "signed-in") return;
    if (h.get("dnt") === "1" || h.get("sec-gpc") === "1") return;
    // Prefetches are not visits. (Public pages are plain links, so a visit is always a full page load.)
    if (
      h.get("rsc") ||
      h.get("next-router-prefetch") ||
      /prefetch/i.test(h.get("purpose") ?? "") ||
      /prefetch/i.test(h.get("sec-purpose") ?? "")
    )
      return;
    const userAgent = h.get("user-agent") ?? "";
    if (isBot(userAgent)) return;
    const secret = process.env["OKS_SECRET"] ?? "";
    if (secret.length < 32) return;
    const siteId = await getSiteId();
    if (!(await enabled(siteId, now))) return;
    const day = statDayOf(now);
    const address =
      h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
    const view: StatView = {
      day,
      hash: visitorHash(dailySecret(secret, siteId, day), address, userAgent),
      path: (path === "" ? "/" : path).slice(0, 200),
      source: sourceOf(h.get("referer"), h.get("host") ?? ""),
      country: countryOf((name) => h.get(name)),
      device: deviceOf(userAgent),
    };
    state.siteId = siteId;
    state.queue.push(view);
    if (state.queue.length >= 200) void flushViews();
    else if (!state.timer) {
      state.timer = setTimeout(() => void flushViews(), FLUSH_MS);
      state.timer.unref?.();
    }
  } catch {
    // Counting must never get in the way of a page.
  }
}
