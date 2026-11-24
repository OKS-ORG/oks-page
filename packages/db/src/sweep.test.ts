// The PostgreSQL test schemas that a stopped test process leaves behind are dropped by the next process; a schema of a process
// that is still running is not touched. (Without it the test database grew to gigabytes and took many minutes to recover.)
import pg from "pg";
import { describe, expect, test } from "vitest";
import { openPg } from "./testing/harness.js";

const url = process.env["DATABASE_URL"];

describe.skipIf(!url)("sweeping stale test schemas", () => {
  test("a schema of a process that is gone is dropped, one of a running process stays", async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    // The parent of this test process is running; 2 million is far above any process id here, so nothing runs under it.
    const live = `t_${process.ppid}_1_0`;
    const dead = "t_2000000_1_0";
    const exists = async (name: string) =>
      (await client.query(`select 1 from pg_namespace where nspname = $1`, [name])).rowCount === 1;
    try {
      await client.query(`create schema if not exists "${live}"`);
      await client.query(`create schema if not exists "${dead}"`);
      await client.query(`create table "${dead}".leftover (id int)`);
      // The first database a process opens sweeps.
      const db = await openPg();
      expect(await exists(dead)).toBe(false);
      expect(await exists(live)).toBe(true);
      await db.close();
    } finally {
      await client.query(`drop schema if exists "${live}" cascade`);
      await client.query(`drop schema if exists "${dead}" cascade`);
      await client.end();
    }
  });
});
