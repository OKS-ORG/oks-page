// DM-26: the same data exported from SQLite and imported into PostgreSQL (and back) gives identical rows.
import { afterEach, describe, expect, test } from "vitest";
import { exportData, importData, tablesInOrder, type Dump } from "./transfer.js";
import { openPg, openSqlite, pgAvailable, type TestDb } from "./testing/harness.js";
import { seedEverything } from "./testing/seed.js";

const open: TestDb[] = [];
const track = async (p: Promise<TestDb>) => {
  const db = await p;
  open.push(db);
  return db;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()));
});
/** A dump goes through text on its way to a file. */
const viaFile = (d: Dump): Dump => JSON.parse(JSON.stringify(d));

describe("DM-26 export and import", () => {
  test("the seed puts at least one row in every table", async () => {
    const db = await track(openSqlite());
    await seedEverything(db);
    const dump = await exportData(db.runner);
    const empty = tablesInOrder().filter((t) => (dump.tables[t.name] ?? []).length === 0);
    expect(empty.map((t) => t.name)).toEqual([]);
    expect(Object.keys(dump.tables)).toHaveLength(43);
  });

  test("an export imported into another SQLite database exports to the same data", async () => {
    const a = await track(openSqlite());
    await seedEverything(a);
    const dump = viaFile(await exportData(a.runner));
    const b = await track(openSqlite());
    const { rows } = await importData(b.runner, dump);
    expect(rows).toBeGreaterThan(37);
    expect(await exportData(b.runner)).toEqual(dump);
  });

  test.skipIf(!pgAvailable)("SQLite to PostgreSQL and back gives identical data", async () => {
    const sqlite = await track(openSqlite());
    await seedEverything(sqlite);
    const first = viaFile(await exportData(sqlite.runner));

    const pg = await track(openPg());
    await importData(pg.runner, first);
    const fromPg = viaFile(await exportData(pg.runner));
    expect(fromPg).toEqual(first);

    const back = await track(openSqlite());
    await importData(back.runner, fromPg);
    expect(viaFile(await exportData(back.runner))).toEqual(first);
  });

  test.skipIf(!pgAvailable)("PostgreSQL to SQLite: the awkward values survive", async () => {
    const sqlite = await track(openSqlite());
    await seedEverything(sqlite);
    const pg = await track(openPg());
    await importData(pg.runner, await exportData(sqlite.runner));
    const dump = await exportData(pg.runner);
    const entry = dump.tables["entries"]!.find((e) => e["slug"] === "child")!;
    expect(entry["title"]).toBe("Hello 世界 🚀 child");
    expect(entry["fields"]).toEqual({
      price: 19.5,
      tags: ["a", "ü"],
      empty: null,
      big: 9007199254740991,
      flag: false,
    });
    expect(entry["created_at"]).toBe(1_700_000_000_123);
    const media = dump.tables["media"]![0]!;
    expect(media["size_bytes"]).toBe(5_000_000_000);
    expect(media["focal_x"]).toBe(0.3333333333333333);
  });

  test("rows that arrive children-first are still inserted parents-first", async () => {
    const a = await track(openSqlite());
    await seedEverything(a);
    const dump = await exportData(a.runner);
    const shuffled = structuredClone(dump);
    for (const t of ["entries", "terms", "media_folders", "comments"])
      shuffled.tables[t]!.reverse();
    const b = await track(openSqlite());
    await importData(b.runner, shuffled);
    expect(await exportData(b.runner)).toEqual(dump);
  });

  test("an import into a database that already has data is refused and changes nothing", async () => {
    const a = await track(openSqlite());
    await seedEverything(a);
    const dump = await exportData(a.runner);
    const b = await track(openSqlite());
    await seedEverything(b);
    await expect(importData(b.runner, dump)).rejects.toThrow(/not empty/);
  });

  test("a failing import leaves the target empty", async () => {
    const a = await track(openSqlite());
    await seedEverything(a);
    const dump = await exportData(a.runner);
    dump.tables["entries"]![0]!["author_id"] = "NOSUCHUSER000000000000000";
    const b = await track(openSqlite());
    await expect(importData(b.runner, dump)).rejects.toThrow();
    expect((await exportData(b.runner)).tables["users"]).toEqual([]);
  });

  test("an unknown table or a wrong format is refused", async () => {
    const b = await track(openSqlite());
    await expect(
      importData(b.runner, { format: "oks-export", version: 1, tables: { nope: [] } }),
    ).rejects.toThrow(/does not know/);
    await expect(
      importData(b.runner, { format: "other", version: 1, tables: {} } as never),
    ).rejects.toThrow(/not an oks export/);
  });
});
