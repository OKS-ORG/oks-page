// DM-27: with 100,000 entries, listing 20 entries of a type sorted by an indexed field takes under 10 ms.
// A speed test: it runs alone (`pnpm test:perf`), because other tests running at the same time slow it down.
import { describe, expect, test } from "vitest";
import { buildEntryList } from "./index.js";
import { openers } from "../testing/harness.js";
import { price, seedPriceEntries, SITE } from "../testing/price-entries.js";

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: DM-27 speed with 100,000 entries`, () => {
    test("listing 20 entries of a type sorted by an indexed field takes under 10 ms", async () => {
      const db = await open();
      try {
        await seedPriceEntries(db, 100_000);
        const q = buildEntryList(kind, {
          siteId: SITE,
          typeKey: "product",
          status: "published",
          sort: { field: price },
          limit: 20,
        });
        await db.run(q.sql, q.params);
        const times: number[] = [];
        for (let i = 0; i < 40; i++) {
          const start = performance.now();
          const rows = await db.run(q.sql, q.params);
          times.push(performance.now() - start);
          expect(rows).toHaveLength(20);
        }
        times.sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)]!;
        console.log(
          `${kind}: median ${median.toFixed(2)} ms, slowest ${times.at(-1)!.toFixed(2)} ms`,
        );
        expect(median).toBeLessThan(10);
      } finally {
        await db.close();
      }
    }, 180_000);
  });
}
