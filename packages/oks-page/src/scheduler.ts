// The timer that keeps the site's scheduled work going while the server runs: it publishes entries whose time has come
// (spec 03, EC-39) and empties the trash after 30 days. It starts once, from instrumentation. Every tick asks the
// database, so a server that was off at the time simply catches up when it starts, and two servers on one database
// do not publish an entry twice (the update itself decides who gets it).
import { capabilitiesOf } from "@oks-page/auth";
import {
  alertAdministrators,
  loadGeneralSettings,
  publishDue,
  purgeEditingNotices,
  purgeSearchStats,
  purgeTrash,
  queueEmail,
  runDailyDomainCheck,
  type MayPublish,
} from "@oks-page/core";
import { getRunner, getSiteId } from "./db";
import { expireTags } from "./expire-tags";
import { kickEmailJobs, runEmailJobs, siteSecrets } from "./mail";
import { purgePendingFiles } from "./plugin-files";
import { purgePrivacyRequests } from "./privacy-visitor";
import { runPluginJobs } from "./plugin-jobs";
import { pluginHost } from "./plugin-runtime";

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
let lastEmailUpkeep = 0;

/**
 * Once an hour: the daily look-up of each site's sender domain (spec 13, section 8), and an email to the
 * administrators when emails keep failing (at most once a day, section 7).
 */
async function emailUpkeep(now: () => number): Promise<void> {
  if (now() - lastEmailUpkeep < PURGE_EVERY) return;
  lastEmailUpkeep = now();
  const runner = getRunner();
  for (const site of await runner.all(`select "id" from "sites"`)) {
    const siteId = String(site["id"]);
    await runDailyDomainCheck(runner, siteId, { now });
    const name = (await loadGeneralSettings(runner, siteId)).siteName;
    const sent = await alertAdministrators(
      runner,
      siteId,
      async (to, subject, text) =>
        (
          await queueEmail(runner, siteId, siteSecrets(), {
            key: "email-trouble",
            to,
            subject: `${subject}: ${name}`,
            text: `${text}\n\n${name}`,
          })
        ).queued,
      now,
    );
    if (sent.length > 0) kickEmailJobs();
  }
}

/** One round: publish what is due, refresh its pages, and now and then empty the old trash. */
export async function runScheduledWork(now: () => number = Date.now): Promise<void> {
  // Queued emails and their retries (spec 13, section 7); it never stops the rest of the round.
  await runEmailJobs().catch((error: unknown) =>
    console.error("[oks] The email queue could not run:", error),
  );
  await emailUpkeep(now).catch((error: unknown) =>
    console.error("[oks] The email checks could not run:", error),
  );
  const result = await publishDue(getRunner(), mayPublish, now);
  for (const entry of [...result.published, ...result.blocked, ...result.held])
    await expireTags(entry.siteId, entry.id, entry.slug);
  if (now() - lastPurge >= PURGE_EVERY) {
    lastPurge = now();
    await purgeEditingNotices(getRunner(), now);
    await purgeSearchStats(getRunner(), now);
    const gone = await purgeTrash(getRunner(), now);
    if (gone > 0)
      console.log(`[oks] Deleted ${gone} item(s) that had been in the trash for 30 days.`);
  }
  // Privacy requests whose link ran out are forgotten, and answered ones after a year.
  await purgePrivacyRequests(getRunner(), now).catch((error: unknown) =>
    console.error("[oks] Old privacy requests could not be cleaned up:", error),
  );
  // Files that visitors sent and no plugin attached to anything are deleted after an hour.
  await purgePendingFiles(getRunner(), now).catch((error: unknown) =>
    console.error("[oks] Old files could not be cleaned up:", error),
  );
  // The tasks plugins run by themselves (spec 04, section 9). Last, because a job may take up to 30 seconds. The
  // sandbox starts only when a job is due.
  try {
    await runPluginJobs({
      runner: getRunner(),
      siteId: await getSiteId(),
      runJob: async (plugin, name, at) => (await pluginHost()).runJob(plugin, name, { at }),
      now,
    });
  } catch (error) {
    // A site that is not set up yet has no plugins and nothing to say.
    if (!(error instanceof Error && /has no site yet/.test(error.message)))
      console.error("[oks] The plugin jobs could not run:", error);
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
