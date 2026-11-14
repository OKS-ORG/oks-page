import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSetup } from "./setup.js";
import {
  dayOf,
  loadSearchStats,
  purgeSearchStats,
  recordSearch,
  termToKeep,
} from "./search-stats.js";

const T = new Date(1_700_000_000_000);
const DAY = 24 * 60 * 60 * 1000;

describe("what a search keeps (SEO-75)", () => {
  test("only the words: trimmed, single spaces, lower case, at most 100 characters", () => {
    expect(termToKeep("  Sourdough   Bread ")).toBe("sourdough bread");
    expect(termToKeep("Ä".repeat(150))).toBe("ä".repeat(100));
    expect(termToKeep("   ")).toBeNull();
  });
  test("never an email address, a phone number or a long number", () => {
    expect(termToKeep("anna@example.com")).toBeNull();
    expect(termToKeep("call +44 20 7946 0958")).toBeNull();
    expect(termToKeep("(555) 123-4567")).toBeNull();
    expect(termToKeep("1234567")).toBeNull();
    expect(termToKeep("४५६७८९०१")).toBeNull();
    expect(termToKeep("bread 2026")).toBe("bread 2026");
    expect(termToKeep("123456")).toBe("123456");
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: search statistics`, () => {
    let db: TestDb;
    let siteId = "";

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, name, email, T, T],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
    });
    afterEach(async () => db.close());

    test("counts per word and day; popular and no-result lists for 90 days; nothing else is stored", async () => {
      const now = () => T.getTime();
      await recordSearch(db.runner, siteId, "Bread", true, now);
      await recordSearch(db.runner, siteId, "bread ", true, now);
      await recordSearch(db.runner, siteId, "bread", true, () => T.getTime() - DAY);
      await recordSearch(db.runner, siteId, "kale", false, now);
      await recordSearch(db.runner, siteId, "kale", true, now);
      expect(await recordSearch(db.runner, siteId, "me@example.com", false, now)).toBe(false);
      const stats = await loadSearchStats(db.runner, siteId, now);
      expect(stats.total).toBe(5);
      expect(stats.popular).toEqual([
        { term: "bread", searches: 3, noResults: 0 },
        { term: "kale", searches: 2, noResults: 1 },
      ]);
      expect(stats.noResults).toEqual([{ term: "kale", searches: 2, noResults: 1 }]);
      const rows = await db.run("select * from search_terms order by term, day");
      expect(rows.map((r) => Object.keys(r).sort())).toEqual(
        Array(3).fill(["day", "no_results", "searches", "site_id", "term"]),
      );
      expect(rows.map((r) => r["term"])).not.toContain("me@example.com");
    });

    test("rows older than 90 days are not counted and are deleted", async () => {
      const now = T.getTime();
      await recordSearch(db.runner, siteId, "old", true, () => now - 90 * DAY);
      await recordSearch(db.runner, siteId, "kept", true, () => now - 89 * DAY);
      expect(
        (await loadSearchStats(db.runner, siteId, () => now)).popular.map((p) => p.term),
      ).toEqual(["kept"]);
      expect(await purgeSearchStats(db.runner, () => now)).toBe(1);
      expect((await db.run("select day from search_terms")).map((r) => r["day"])).toEqual([
        dayOf(now - 89 * DAY),
      ]);
    });
  });
}
