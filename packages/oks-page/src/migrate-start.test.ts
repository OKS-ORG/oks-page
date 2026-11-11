// A new install has an empty database: starting the site makes the tables (the project's instrumentation.ts calls this).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const shared = globalThis as typeof globalThis & { __oks?: unknown };

describe("migrating a new database when the server starts", () => {
  let dir = "";
  const before = { path: process.env["OKS_SQLITE_PATH"], url: process.env["OKS_DATABASE_URL"] };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oks-start-"));
    delete process.env["OKS_DATABASE_URL"];
    process.env["OKS_SQLITE_PATH"] = join(dir, "site.sqlite");
    delete shared.__oks; // a fresh connection for each test
    vi.resetModules(); // and a fresh copy of the module that keeps it
  });
  afterEach(() => {
    delete shared.__oks;
    for (const [key, value] of [
      ["OKS_SQLITE_PATH", before.path],
      ["OKS_DATABASE_URL", before.url],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });

  test("an empty SQLite file gets every table, and a second start changes nothing", async () => {
    const { getRunner, migrateDatabase } = await import("./db");
    const first = await migrateDatabase();
    expect(first.length).toBeGreaterThan(0);
    const tables = (
      await getRunner().all(
        `select name from sqlite_master where type = 'table' and name = 'entries'`,
      )
    ).length;
    expect(tables).toBe(1);
    expect(await migrateDatabase()).toEqual([]);
  });

  test("register() migrates on a Node.js server, and not when it is turned off or while building", async () => {
    const { register } = await import("./instrumentation");
    const { getRunner } = await import("./db");
    const tableCount = async () =>
      (await getRunner().all(`select count(*) as n from sqlite_master where type = 'table'`))[0]![
        "n"
      ];

    process.env["OKS_AUTO_MIGRATE"] = "0";
    await register();
    expect(await tableCount()).toBe(0);
    delete process.env["OKS_AUTO_MIGRATE"];

    process.env["NEXT_PHASE"] = "phase-production-build";
    await register();
    expect(await tableCount()).toBe(0);
    delete process.env["NEXT_PHASE"];

    process.env["NEXT_RUNTIME"] = "nodejs";
    await register();
    expect(Number(await tableCount())).toBeGreaterThan(10);
    delete process.env["NEXT_RUNTIME"];
  });
});
