// The timed tasks of plugins (spec 04, section 9): when a job is first due, that a finished job schedules the next one an
// interval later, how a failing job is tried again, that a plugin which is off or damaged runs nothing, and what goes
// with a removed plugin. A fake clock and a fake sandbox, in SQLite and PostgreSQL.
import type { Actor } from "@oks-page/core";
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { removePlugin } from "./plugin-admin";
import { pluginJobKind, pluginJobStatus, runPluginJobs, type PluginJobRun } from "./plugin-jobs";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000092";
const MIN = 60_000;
const owner: Actor = { userId: "USER0000000000000000000092", can: () => true };

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: plugin jobs on a timer`, () => {
    let db: TestDb;
    let clock = 1_800_000_000_000;
    let calls: { plugin: string; name: string; at: number }[] = [];
    let answer: PluginJobRun = { ok: true };
    let n = 0;

    const addPlugin = async (key: string, status: string, manifest: unknown) =>
      db.run(
        "insert into extensions (id, site_id, key, kind, version, tier, status, manifest, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?, ?, ?)",
        [`EXT${String(++n).padStart(23, "0")}`, SITE, key, status, JSON.stringify(manifest), T],
      );
    const tick = () =>
      runPluginJobs({
        runner: db.runner,
        siteId: SITE,
        now: () => clock,
        runJob: async (plugin, name, at) => {
          calls.push({ plugin, name, at });
          return answer;
        },
      });
    const rows = (k: string) =>
      db.runner.all(
        `select "status", "attempts", "run_at", "finished_at", "last_error" from jobs where site_id = ? and kind = ? order by created_at, id`,
        [SITE, k],
      );

    beforeEach(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      clock = 1_800_000_000_000;
      calls = [];
      answer = { ok: true };
    });

    test("the first run is one interval after the plugin was seen; a finished run schedules the next one an interval later", async () => {
      await addPlugin("forms", "enabled", { jobs: { keep: { everyMinutes: 60 } } });
      expect(await tick()).toEqual({ scheduled: 1, done: 0, failed: 0 });
      // Nothing runs before it is due, and nothing is queued twice.
      clock += 59 * MIN;
      expect(await tick()).toEqual({ scheduled: 0, done: 0, failed: 0 });
      expect(calls).toEqual([]);
      clock += 2 * MIN;
      const run = await tick();
      expect(run).toMatchObject({ done: 1, failed: 0 });
      expect(calls).toEqual([{ plugin: "forms", name: "keep", at: clock }]);
      // The next tick queues the following run, one interval after this one finished.
      const finished = clock;
      expect(await tick()).toMatchObject({ scheduled: 1, done: 0 });
      const status = await pluginJobStatus(db.runner, SITE, "forms", {
        keep: { everyMinutes: 60 },
      });
      expect(status).toEqual([
        {
          name: "keep",
          everyMinutes: 60,
          last: { at: finished, ok: true },
          next: finished + 60 * MIN,
        },
      ]);
    });

    test("a server that was off catches up with one run, not one for every missed interval", async () => {
      await addPlugin("forms", "enabled", { jobs: { keep: { everyMinutes: 60 } } });
      await tick();
      clock += 30 * 24 * 60 * MIN;
      expect(await tick()).toMatchObject({ done: 1 });
      expect(calls.length).toBe(1);
      expect(await tick()).toMatchObject({ scheduled: 1, done: 0 });
      expect(calls.length).toBe(1);
    });

    test("a failing job is tried again 5 minutes later, up to 3 times, then waits for its next interval", async () => {
      await addPlugin("forms", "enabled", { jobs: { keep: { everyMinutes: 60 } } });
      await tick();
      clock += 61 * MIN;
      answer = { ok: false, skipped: false, error: "it broke" };
      expect(await tick()).toMatchObject({ done: 0, failed: 0 });
      let job = (await rows(pluginJobKind("forms", "keep")))[0]!;
      expect(String(job["status"])).toBe("queued");
      expect(Number(job["attempts"])).toBe(1);
      expect(String(job["last_error"])).toBe("it broke");
      // Not yet.
      clock += 4 * MIN;
      await tick();
      expect(calls.length).toBe(1);
      clock += 2 * MIN;
      await tick();
      expect(calls.length).toBe(2);
      // The third try is 10 minutes after the second, and it is the last.
      clock += 11 * MIN;
      expect(await tick()).toMatchObject({ failed: 1 });
      expect(calls.length).toBe(3);
      job = (await rows(pluginJobKind("forms", "keep")))[0]!;
      expect(String(job["status"])).toBe("failed");
      const failedAt = clock;
      // The next run waits a whole interval after the failure.
      answer = { ok: true };
      await tick();
      clock += 59 * MIN;
      await tick();
      expect(calls.length).toBe(3);
      clock += 2 * MIN;
      expect(await tick()).toMatchObject({ done: 1 });
      expect(calls.length).toBe(4);
      expect(clock - failedAt).toBeGreaterThan(60 * MIN);
      const status = await pluginJobStatus(db.runner, SITE, "forms", {
        keep: { everyMinutes: 60 },
      });
      expect(status[0]!.last?.ok).toBe(true);
    });

    test("a plugin that is off, or cannot run the job, fails at once and is not tried again", async () => {
      await addPlugin("forms", "enabled", { jobs: { keep: { everyMinutes: 60 } } });
      await tick();
      clock += 61 * MIN;
      answer = { ok: false, skipped: true, error: "This job is not available." };
      expect(await tick()).toMatchObject({ failed: 1 });
      expect(calls.length).toBe(1);
      const job = (await rows(pluginJobKind("forms", "keep")))[0]!;
      expect(String(job["status"])).toBe("failed");
    });

    test("only plugins that are on and have a sound manifest run jobs; a removed plugin leaves no jobs behind", async () => {
      await addPlugin("on", "enabled", {
        jobs: { a: { everyMinutes: 5 }, b: { everyMinutes: 10 } },
      });
      await addPlugin("off", "disabled", { jobs: { a: { everyMinutes: 5 } } });
      await addPlugin("damaged", "enabled", { jobs: { a: { everyMinutes: 1 } } });
      await addPlugin("plain", "enabled", {});
      expect(await tick()).toEqual({ scheduled: 2, done: 0, failed: 0 });
      clock += 11 * MIN;
      expect(await tick()).toMatchObject({ done: 2 });
      expect(calls.map((c) => `${c.plugin}:${c.name}`).sort()).toEqual(["on:a", "on:b"]);
      // Removing the plugin takes its runs with it.
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, 'O', 'o@example.com', ?, ?)",
        [owner.userId, T, T],
      );
      expect((await rows(pluginJobKind("on", "a"))).length).toBeGreaterThan(0);
      expect((await removePlugin(db.runner, owner, SITE, "on")).ok).toBe(true);
      expect((await rows(pluginJobKind("on", "a"))).length).toBe(0);
      expect((await rows(pluginJobKind("on", "b"))).length).toBe(0);
      calls = [];
      clock += 60 * MIN;
      expect(await tick()).toEqual({ scheduled: 0, done: 0, failed: 0 });
    });

    test("runs older than a week are forgotten", async () => {
      await addPlugin("forms", "enabled", { jobs: { keep: { everyMinutes: 60 } } });
      const k = pluginJobKind("forms", "keep");
      for (let i = 0; i < 3; i += 1)
        await db.run(
          `insert into jobs (id, site_id, kind, payload, run_at, status, attempts, max_attempts, created_at, finished_at) values (?, ?, ?, '{}', ?, 'done', 1, 3, ?, ?)`,
          [
            `JOB${String(i).padStart(23, "0")}`,
            SITE,
            k,
            new Date(clock - 9 * 24 * 60 * MIN),
            T,
            new Date(clock - [9, 8, 2][i]! * 24 * 60 * MIN),
          ],
        );
      await tick();
      // Two of the three finished more than 7 days ago and are gone. The recent one decided that the next run was already
      // due (2 days late for an hour), so it ran now: what is left is that run and the recent one.
      const left = await rows(k);
      expect(left.length).toBe(2);
      for (const r of left)
        expect(
          new Date(r["finished_at"] as string | number | Date).getTime(),
        ).toBeGreaterThanOrEqual(clock - 7 * 24 * 60 * MIN);
    });
  });
}
