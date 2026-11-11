// A small job runner on the `jobs` table (spec 09 section 3; ADR 0015): work that is too slow to do while a request
// waits, such as the image sizes. A job is queued, claimed by one worker, and ends done or failed. A failed attempt is
// tried again later, up to the job's limit. At most `concurrency` jobs run at once in one process.
import { newId, type SqlRunner } from "@oks-page/db";

export interface Job {
  id: string;
  siteId: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/** Throw this from a handler when trying again cannot help (the file is damaged). The job fails at once. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export interface JobHandler {
  run(job: Job): Promise<void>;
  /** Called once when the job has failed for good. */
  giveUp?(job: Job, error: Error): Promise<void>;
}

const BACKOFF_MS = 30_000;

export async function enqueueJob(
  runner: SqlRunner,
  siteId: string,
  kind: string,
  payload: unknown,
  now: () => number = Date.now,
): Promise<string> {
  const id = newId();
  const at = new Date(now());
  await runner.all(
    `insert into "jobs" ("id", "site_id", "kind", "payload", "run_at", "status", "attempts", "max_attempts", "created_at")
     values (?, ?, ?, ?, ?, 'queued', 0, 5, ?)`,
    [id, siteId, kind, JSON.stringify(payload), at, at],
  );
  return id;
}

/** Takes the next due job of the given kinds, or null. Two servers on one database never get the same job. */
export async function claimJob(
  runner: SqlRunner,
  workerId: string,
  kinds: string[],
  now: () => number = Date.now,
): Promise<Job | null> {
  if (kinds.length === 0) return null;
  const at = new Date(now());
  const marks = kinds.map(() => "?").join(", ");
  const lock = runner.dialect === "postgres" ? " for update skip locked" : "";
  const rows = await runner.all(
    `update "jobs" set "status" = 'running', "locked_by" = ?, "locked_at" = ?, "attempts" = "attempts" + 1
     where "status" = 'queued' and "id" = (
       select "id" from "jobs" where "status" = 'queued' and "run_at" <= ? and "kind" in (${marks})
       order by "run_at", "id" limit 1${lock}
     )
     returning "id", "site_id", "kind", "payload", "attempts", "max_attempts"`,
    [workerId, at, at, ...kinds],
  );
  const row = rows[0];
  if (!row) return null;
  const raw = row["payload"];
  return {
    id: String(row["id"]),
    siteId: String(row["site_id"]),
    kind: String(row["kind"]),
    payload: typeof raw === "string" ? JSON.parse(raw) : raw,
    attempts: Number(row["attempts"]),
    maxAttempts: Number(row["max_attempts"]),
  };
}

export async function finishJob(
  runner: SqlRunner,
  id: string,
  now: () => number = Date.now,
): Promise<void> {
  await runner.all(
    `update "jobs" set "status" = 'done', "locked_by" = null, "locked_at" = null, "finished_at" = ? where "id" = ?`,
    [new Date(now()), id],
  );
}

/** Records a failed attempt. Returns true when the job is finished for good (no more tries). */
export async function failJob(
  runner: SqlRunner,
  job: Job,
  error: Error,
  now: () => number = Date.now,
): Promise<boolean> {
  const final = error instanceof PermanentJobError || job.attempts >= job.maxAttempts;
  const at = now();
  if (final) {
    await runner.all(
      `update "jobs" set "status" = 'failed', "last_error" = ?, "locked_by" = null, "locked_at" = null, "finished_at" = ? where "id" = ?`,
      [error.message.slice(0, 1000), new Date(at), job.id],
    );
  } else {
    await runner.all(
      `update "jobs" set "status" = 'queued', "last_error" = ?, "locked_by" = null, "locked_at" = null, "run_at" = ? where "id" = ?`,
      [error.message.slice(0, 1000), new Date(at + BACKOFF_MS * job.attempts), job.id],
    );
  }
  return final;
}

/** Puts jobs back in the queue when a server stopped while running them. */
export async function recoverStaleJobs(
  runner: SqlRunner,
  olderThanMs = 10 * 60_000,
  now: () => number = Date.now,
): Promise<number> {
  const rows = await runner.all(
    `update "jobs" set "status" = 'queued', "locked_by" = null, "locked_at" = null
     where "status" = 'running' and "locked_at" < ? returning "id"`,
    [new Date(now() - olderThanMs)],
  );
  return rows.length;
}

let active = 0;

/**
 * Runs due jobs until none are left, with at most `concurrency` at once in this process (spec 09: 2 image jobs).
 * Resolves when the workers started by this call have finished.
 */
export async function drainJobs(
  runner: SqlRunner,
  handlers: Record<string, JobHandler>,
  options: { concurrency?: number; workerId?: string; now?: () => number } = {},
): Promise<{ done: number; failed: number }> {
  const concurrency = options.concurrency ?? 2;
  const workerId = options.workerId ?? `worker-${process.pid}`;
  const now = options.now ?? Date.now;
  const kinds = Object.keys(handlers);
  const counts = { done: 0, failed: 0 };

  const worker = async () => {
    for (;;) {
      const job = await claimJob(runner, workerId, kinds, now);
      if (!job) return;
      const handler = handlers[job.kind]!;
      try {
        await handler.run(job);
        await finishJob(runner, job.id, now);
        counts.done += 1;
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        const final = await failJob(runner, job, error, now);
        if (final) {
          counts.failed += 1;
          await handler.giveUp?.(job, error).catch(() => undefined);
        }
      }
    }
  };

  const started: Promise<void>[] = [];
  while (active < concurrency) {
    active += 1;
    started.push(worker().finally(() => (active -= 1)));
  }
  await Promise.all(started);
  return counts;
}
