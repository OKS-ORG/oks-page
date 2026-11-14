// The timer that keeps the site's scheduled work going while the server runs: it publishes entries whose time has come
// (spec 03, EC-39) and empties the trash after 30 days. It starts once, from instrumentation. Every tick asks the
// database, so a server that was off at the time simply catches up when it starts, and two servers on one database
// do not publish an entry twice (the update itself decides who gets it).
import { capabilitiesOf } from "@oks-page/auth";
import { publishDue, purgeEditingNotices, purgeTrash, type MayPublish } from "@oks-page/core";
import { getRunner } from "./db";
import { expireTags } from "./expire-tags";
import { runEmailJobs } from "./mail";

const SECOND = 1000;
const PURGE_EVERY = 60 * 60 * SECOND;

const mayPublish: MayPublish = async ({ siteId, userId, type, authorId }) => {
  const caps = await capabilitiesOf(getRunner(), siteId, userId);
  return (
    caps.can("content.publish_any", type) ||
    (caps.can("content.publish_own", type) && authorId === userId)
  );
};

let lastPurge = 0;

/** One round: publish what is due, refresh its pages, and now and then empty the old trash. */
export async function runScheduledWork(now: () => number = Date.now): Promise<void> {
  // Queued emails and their retries (spec 13, section 7); it never stops the rest of the round.
  await runEmailJobs().catch((error: unknown) =>
    console.error("[oks] The email queue could not run:", error),
  );
  const result = await publishDue(getRunner(), mayPublish, now);
  for (const entry of [...result.published, ...result.blocked])
    await expireTags(entry.siteId, entry.id, entry.slug);
  if (now() - lastPurge >= PURGE_EVERY) {
    lastPurge = now();
    await purgeEditingNotices(getRunner(), now);
    const gone = await purgeTrash(getRunner(), now);
    if (gone > 0)
      console.log(`[oks] Deleted ${gone} item(s) that had been in the trash for 30 days.`);
  }
}

/** Starts the timer. OKS_SCHEDULER_SECONDS changes how often it looks (default 30). Calling it twice does nothing. */
export function startScheduler(): void {
  const state = globalThis as { __oksScheduler?: boolean };
  if (state.__oksScheduler) return;
  state.__oksScheduler = true;
  const every = Math.max(1, Number(process.env["OKS_SCHEDULER_SECONDS"]) || 30) * SECOND;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runScheduledWork();
    } catch (error) {
      console.error("[oks] The scheduled work failed, will try again:", error);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), every).unref();
  void tick();
}
