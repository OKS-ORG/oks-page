// S8: what a real minimal installation needs. Measures the real site (server mode, SQLite) for the hosting
// requirements table: memory after start, memory after 200 and after 3,000 requests, and the time until the first page
// is served, with Node's default heap and with a capped heap. A speed test: it runs alone (`pnpm test:perf`).
// Linux only (it reads the process list).
import { openSqlite, type TestDb } from "@oks-page/db/testing";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildSite, seed, startSite } from "./helpers";

/** The memory (RSS, in MB) of a process and every process it started. */
function treeRssMb(pid: number): number {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number, number]);
  const family = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, parent] of rows)
      if (family.has(parent) && !family.has(p)) {
        family.add(p);
        grew = true;
      }
  }
  return rows.filter(([p]) => family.has(p)).reduce((sum, [, , rss]) => sum + rss, 0) / 1024;
}

const SETTINGS = [
  { name: "Node's default heap", nodeOptions: "" },
  { name: "heap capped at 128 MB", nodeOptions: "--max-old-space-size=128" },
];

describe.skipIf(process.platform !== "linux")(
  "S8: the minimal site's memory and start time",
  () => {
    let db: TestDb;

    beforeAll(async () => {
      buildSite();
      db = await openSqlite(join(mkdtempSync(join(tmpdir(), "oks-s8-")), "site.sqlite"));
      const s = await seed(db);
      await s.entry("home", "Home");
      for (let i = 0; i < 50; i++)
        await s.entry(`blog/post-${i}`, `Post ${i}`, "published", "post");
    }, 600_000);

    afterAll(async () => {
      await db?.close();
    });

    for (const { name, nodeOptions } of SETTINGS) {
      test(`${name}: memory after start, after 200 requests and after 3,000, and the start time`, async () => {
        const started = Date.now();
        const site = await startSite(
          "sqlite",
          db,
          nodeOptions ? { NODE_OPTIONS: nodeOptions } : {},
        );
        try {
          const startSeconds = (Date.now() - started) / 1000;
          const afterStartMb = treeRssMb(site.server.pid!);
          const paths = ["/", ...Array.from({ length: 50 }, (_, i) => `/blog/post-${i}`)];
          let sent = 0;
          let failed = 0;
          const send = async (count: number) => {
            for (let done = 0; done < count; done += 10)
              await Promise.all(
                Array.from({ length: 10 }, async () => {
                  const res = await fetch(site.base + paths[sent++ % paths.length]!, {
                    signal: AbortSignal.timeout(20_000),
                  });
                  await res.arrayBuffer();
                  if (res.status !== 200) failed++;
                }),
              );
          };
          await send(200);
          const after200Mb = treeRssMb(site.server.pid!);
          await send(2800);
          const after3000Mb = treeRssMb(site.server.pid!);
          console.log(
            `S8 (${name}): start ${startSeconds.toFixed(1)} s; after start ${afterStartMb.toFixed(0)} MB; after 200 requests ${after200Mb.toFixed(0)} MB; after 3,000 ${after3000Mb.toFixed(0)} MB; failed requests ${failed}`,
          );
          // Loose limits, so a real jump (a leak, a heavy new dependency) is noticed. The measured numbers go into
          // the hosting requirements table; no minimum RAM is promised from these limits.
          expect(failed).toBe(0);
          expect(afterStartMb).toBeLessThan(512);
          // Node 24 with its default heap has been seen at 650 to 680 MB here while a capped heap stays steady, so this
          // limit is wide enough not to fail on garbage-collection timing.
          expect(after3000Mb).toBeLessThan(800);
          expect(startSeconds).toBeLessThan(30);
        } finally {
          site.server.kill();
        }
      }, 300_000);
    }
  },
);
