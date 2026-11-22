// The tasks plugins run by themselves (spec 04, section 9). A plugin lists jobs in its manifest, each with an interval
// in minutes. Every round of the site's timer, this makes sure each job of each plugin that is switched on has one
// queued run in the `jobs` table (the next one is due one interval after the last one finished), then runs what is due.
// A job that fails is tried again up to 3 times, 5 minutes apart, then waits for its next interval. The plugin runs in
// the sandbox with the job time limit and the usual failure rules, so one that keeps failing is switched off.
import { drainJobs, PermanentJobError, type JobHandler } from "@oks-page/core";
import { newId, type SqlRunner } from "@oks-page/db";
import { readJobs } from "@oks-page/sandbox";

const MINUTE = 60_000;
const KEEP_RUNS_MS = 7 * 24 * 60 * MINUTE;

export const pluginJobKind = (plugin: string, name: string): string => `plugin:${plugin}:${name}`;

export type PluginJobRun = { ok: true } | { ok: false; skipped: boolean; error: string };

export interface PluginJobDeps {
  runner: SqlRunner;
  siteId: string;
  /** Runs one job in the sandbox. Called only when a job is due, so the sandbox starts only when it is needed. */
  runJob: (plugin: string, name: string, at: number) => Promise<PluginJobRun>;
  now?: () => number;
}

const parse = (value: unknown): Record<string, unknown> => {
  try {
    const v = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Queues the next run of each declared job that has none waiting, and runs what is due. */
export async function runPluginJobs(
  deps: PluginJobDeps,
): Promise<{ scheduled: number; done: number; failed: number }> {
  const { runner, siteId } = deps;
  const now = deps.now ?? Date.now;
  const rows = await runner.all(
    `select "key", "manifest" from "extensions" where "site_id" = ? and "kind" = 'plugin' and "status" = 'enabled'`,
    [siteId],
  );
  const handlers: Record<string, JobHandler> = {};
  let scheduled = 0;
  for (const row of rows) {
    const plugin = String(row["key"]);
    const declared = readJobs(parse(row["manifest"])["jobs"] ?? {});
    // A manifest that was damaged after it was stored runs nothing.
    if (typeof declared === "string") continue;
    for (const [name, info] of Object.entries(declared)) {
      const kind = pluginJobKind(plugin, name);
      const waiting = await runner.all(
        `select "id" from "jobs" where "site_id" = ? and "kind" = ? and "status" in ('queued', 'running')`,
        [siteId, kind],
      );
      if (waiting.length === 0) {
        const last = (
          await runner.all(
            `select max("finished_at") as "at" from "jobs" where "site_id" = ? and "kind" = ? and "status" in ('done', 'failed')`,
            [siteId, kind],
          )
        )[0]?.["at"];
        const base = last ? new Date(last as string | number | Date).getTime() : now();
        const at = new Date(base + info.everyMinutes * MINUTE);
        await runner.all(
          `insert into "jobs" ("id", "site_id", "kind", "payload", "run_at", "status", "attempts", "max_attempts", "created_at")
           values (?, ?, ?, ?, ?, 'queued', 0, 3, ?)`,
          [newId(), siteId, kind, JSON.stringify({ plugin, name }), at, new Date(now())],
        );
        scheduled += 1;
      }
      // Runs older than a week are forgotten; the last one is always newer than the longest interval.
      await runner.all(
        `delete from "jobs" where "site_id" = ? and "kind" = ? and "status" in ('done', 'failed') and "finished_at" < ?`,
        [siteId, kind, new Date(now() - KEEP_RUNS_MS)],
      );
      handlers[kind] = {
        async run() {
          const r = await deps.runJob(plugin, name, now());
          if (r.ok) return;
          // A plugin that is off or has no such job cannot be helped by trying again.
          throw r.skipped ? new PermanentJobError(r.error) : new Error(r.error);
        },
        retryDelay: (attempts) => 5 * MINUTE * attempts,
      };
    }
  }
  if (Object.keys(handlers).length === 0) return { scheduled, done: 0, failed: 0 };
  const counts = await drainJobs(runner, handlers, { concurrency: 1, now });
  return { scheduled, ...counts };
}

export interface PluginJobStatus {
  name: string;
  everyMinutes: number;
  /** The last run that ended: when, whether it worked, and the reason when it did not. */
  last: { at: number; ok: boolean; error?: string } | null;
  /** When the next run is due, or null when none is queued yet. */
  next: number | null;
}

/** What the Plugins screen shows about a plugin's jobs. */
export async function pluginJobStatus(
  runner: SqlRunner,
  siteId: string,
  plugin: string,
  manifestJobs: unknown,
): Promise<PluginJobStatus[]> {
  const declared = readJobs(manifestJobs ?? {});
  if (typeof declared === "string") return [];
  const out: PluginJobStatus[] = [];
  for (const [name, info] of Object.entries(declared)) {
    const kind = pluginJobKind(plugin, name);
    const last = (
      await runner.all(
        `select "status", "finished_at", "last_error" from "jobs" where "site_id" = ? and "kind" = ? and "status" in ('done', 'failed') order by "finished_at" desc limit 1`,
        [siteId, kind],
      )
    )[0];
    const next = (
      await runner.all(
        `select "run_at" from "jobs" where "site_id" = ? and "kind" = ? and "status" in ('queued', 'running') order by "run_at" limit 1`,
        [siteId, kind],
      )
    )[0];
    out.push({
      name,
      everyMinutes: info.everyMinutes,
      last: last
        ? {
            at: new Date(last["finished_at"] as string | number | Date).getTime(),
            ok: String(last["status"]) === "done",
            ...(last["last_error"] ? { error: String(last["last_error"]).slice(0, 200) } : {}),
          }
        : null,
      next: next ? new Date(next["run_at"] as string | number | Date).getTime() : null,
    });
  }
  return out;
}
