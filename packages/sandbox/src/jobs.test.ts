// The tasks a plugin runs by itself (spec 04, section 9): what a manifest may say about them, and how the sandbox runs
// one: only when the plugin is on and lists it, with its own time limit, and with the usual failure rules. In SQLite
// and PostgreSQL, on the real sandbox.
import { openers, type TestDb } from "@oks-page/db/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxHost } from "./host.js";
import { makePluginFile, readJobs, readPluginFile } from "./plugin-file.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000091";
const EXT = "EXT00000000000000000000091";

const CODE = `export default { jobs: {
  tick: async (info, ctx) => { const n = (await ctx.storage.get("c", "n")) || 0; await ctx.storage.set("c", "n", n + 1); await ctx.storage.set("c", "at", info.at); },
  boom: async () => { throw new Error("it broke"); },
  slow: async () => { await new Promise((r) => setTimeout(r, 60000)); },
  write: async (info, ctx) => { await ctx.content.update("x", { title: "t" }); },
} };`;

describe("what a manifest may say about jobs", () => {
  test("every N minutes, from 5 to 7 days, at most 5 jobs, with plain names", () => {
    expect(readJobs({ keep: { everyMinutes: 1440 }, ping: { everyMinutes: 5 } })).toEqual({
      keep: { everyMinutes: 1440 },
      ping: { everyMinutes: 5 },
    });
    for (const bad of [
      [],
      { Keep: { everyMinutes: 60 } },
      { keep: { everyMinutes: 4 } },
      { keep: { everyMinutes: 10_081 } },
      { keep: { everyMinutes: 1.5 } },
      { keep: { everyMinutes: "60" } },
      { keep: {} },
      { keep: { cron: "0 3 * * *" } },
      Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`j${i}`, { everyMinutes: 60 }])),
    ])
      expect(typeof readJobs(bad), JSON.stringify(bad)).toBe("string");
  });

  test("a plugin file carries its jobs, and refuses broken ones", () => {
    const manifest = {
      id: "job-demo",
      version: "1.0.0",
      displayName: "Job demo",
      description: "d",
      author: "a",
      permissions: [],
      hooks: [],
      blocks: [],
      jobs: { tick: { everyMinutes: 60 } },
    };
    const ok = readPluginFile(JSON.stringify(makePluginFile(manifest, "export default {};")));
    expect(ok.ok && ok.file.manifest.jobs).toEqual({ tick: { everyMinutes: 60 } });
    const bad = readPluginFile(
      JSON.stringify(
        makePluginFile(
          { ...manifest, jobs: { tick: { everyMinutes: 1 } } } as never,
          "export default {};",
        ),
      ),
    );
    expect(bad.ok).toBe(false);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: running a plugin's job`, () => {
    let db: TestDb;
    let host: SandboxHost;
    const workDir = mkdtempSync(join(tmpdir(), "oks-jobs-"));

    const count = async () => {
      const rows = await db.runner.all(
        `select "value" from extension_storage where extension_id = ? and collection = 'c' and key = 'n'`,
        [EXT],
      );
      const raw = rows[0]?.["value"];
      return raw === undefined ? 0 : Number(typeof raw === "string" ? JSON.parse(raw) : raw);
    };

    beforeAll(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      await db.run(
        "insert into extensions (id, site_id, key, kind, version, tier, installed_at) values (?, ?, 'jobber', 'plugin', '1.0.0', 'runtime', ?)",
        [EXT, SITE, T],
      );
      host = new SandboxHost({
        runner: db.runner,
        siteId: SITE,
        content: { get: async () => null, update: async () => null },
        workDir,
        wallMs: 10_000,
        publishWallMs: 3000,
        jobWallMs: 1500,
        maxFailures: 3,
        onDeveloperNote: () => undefined,
      });
      await host.listen();
      host.load(
        {
          id: "jobber",
          version: "1.0.0",
          permissions: [],
          jobs: {
            tick: { everyMinutes: 60 },
            boom: { everyMinutes: 60 },
            slow: { everyMinutes: 60 },
            write: { everyMinutes: 60 },
          },
        },
        CODE,
        EXT,
      );
      // Start the plugin's process now, so the 1.5 second limit of a job measures the job and not a cold start.
      await host.describe("jobber");
    });

    afterAll(async () => {
      await host.close();
      await db.close();
      rmSync(workDir, { recursive: true, force: true });
    });

    test("a listed job runs in the sandbox with the time it was started at, and its work is kept", async () => {
      expect(host.jobsOf("jobber")).toMatchObject({ tick: { everyMinutes: 60 } });
      const r = await host.runJob("jobber", "tick", { at: 1234 });
      expect(r).toEqual({ ok: true });
      expect(await host.runJob("jobber", "tick")).toEqual({ ok: true });
      expect(await count()).toBe(2);
      const at = await db.runner.all(
        `select "value" from extension_storage where extension_id = ? and collection = 'c' and key = 'at'`,
        [EXT],
      );
      expect(at.length).toBe(1);
    });

    test("a job that is not listed, a plugin that is not known and a job the code lacks cannot be run", async () => {
      const unlisted = await host.runJob("jobber", "nothing");
      expect(unlisted).toMatchObject({ ok: false, skipped: true });
      const unknown = await host.runJob("nobody", "tick");
      expect(unknown).toMatchObject({ ok: false, skipped: true });
      expect(host.jobsOf("nobody")).toEqual({});
    });

    test("a job that throws is a failure with a short reason; a permission refusal is not a failure", async () => {
      const r = await host.runJob("jobber", "boom");
      expect(r).toMatchObject({ ok: false, skipped: false });
      expect(!r.ok && r.error).toContain("it broke");
      expect(host.status("jobber")).toBe("enabled");
      // It asked to write content without the permission: refused, and that does not count toward switching it off.
      const refused = await host.runJob("jobber", "write");
      expect(refused.ok).toBe(false);
      expect(host.status("jobber")).toBe("enabled");
    });

    test("a job that takes too long is stopped by the job time limit, and repeated failures switch the plugin off", async () => {
      const started = Date.now();
      const r = await host.runJob("jobber", "slow");
      expect(r).toMatchObject({ ok: false });
      expect(!r.ok && r.error).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(5000);
      // boom (1) and slow (2) so far within the window; one more failure switches the plugin off.
      await host.runJob("jobber", "boom");
      expect(host.status("jobber")).toBe("switched_off");
      const off = await host.runJob("jobber", "tick");
      expect(off).toMatchObject({ ok: false, skipped: true });
      expect(host.jobsOf("jobber")).toEqual({});
    }, 20_000);
  });
}
