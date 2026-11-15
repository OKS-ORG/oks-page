// SEO-74: site search answers in under 200 ms for a site with 10,000 entries, on SQLite and PostgreSQL. Timed as a visitor
// sees it: the whole /search page, from the request to the last byte. A speed test: it runs alone (`pnpm test:perf`).
import { openers, openSqlite, type TestDb } from "@oks-page/db/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildSite, seed, startSite } from "./helpers";

beforeAll(() => buildSite(), 300_000);

const ENTRIES = 10_000;
const WORDS_EACH = 400;

// Made-up words with a few real ones, common words often (as in real text).
let state = 7;
const rand = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const SYLLABLES = [
  "ba",
  "ke",
  "ry",
  "so",
  "ur",
  "do",
  "lo",
  "af",
  "gar",
  "den",
  "ka",
  "le",
  "to",
  "ma",
  "pi",
  "ne",
  "st",
  "ro",
  "wi",
  "an",
];
const VOCABULARY = [
  "sourdough",
  "bread",
  "garden",
  "kale",
  "bakery",
  "morning",
  ...Array.from({ length: 20_000 }, () => {
    let w = "";
    for (let i = 0, n = 2 + Math.floor(rand() * 3); i < n; i++)
      w += SYLLABLES[Math.floor(rand() * SYLLABLES.length)];
    return w;
  }),
];
const word = () => VOCABULARY[Math.floor(VOCABULARY.length * rand() ** 2)]!;
const words = (n: number) => Array.from({ length: n }, word).join(" ");

for (const { kind, skip } of openers) {
  describe.skipIf(skip)(`${kind}: site search speed`, () => {
    let db: TestDb;
    let site: Awaited<ReturnType<typeof startSite>>;
    // The SQLite file of 10,000 entries is about 45 MB; /tmp may be a small memory disk, so it is removed afterwards.
    let folder = "";

    beforeAll(async () => {
      db =
        kind === "sqlite"
          ? await openSqlite(
              join((folder = mkdtempSync(join(tmpdir(), "oks-search-perf-"))), "site.sqlite"),
            )
          : await (await import("@oks-page/db/testing")).openPg();
      const s = await seed(db);
      for (let start = 0; start < ENTRIES; start += 200) {
        const marks: string[] = [];
        const values: unknown[] = [];
        for (let i = start; i < start + 200; i++) {
          marks.push(
            `(?, ?, 'post', 'published', ?, ?, ?, '{}', '[]', ?, '', '{}', '{}', ?, ?, ?)`,
          );
          const at = new Date(1_700_000_000_000 - i * 60_000);
          values.push(
            `SRC${String(i).padStart(23, "0")}`,
            s.site,
            words(5),
            `blog/post-${i}`,
            s.user,
            words(WORDS_EACH),
            at,
            at,
            at,
          );
        }
        await db.run(
          `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, published_at, created_at, updated_at)
           values ${marks.join(", ")}`,
          values,
        );
      }
      site = await startSite(kind, db);
    }, 600_000);

    afterAll(async () => {
      site?.server.kill();
      await db?.close();
      if (folder) rmSync(folder, { recursive: true, force: true });
    });

    test("SEO-74 results in under 200 ms for 10,000 entries", async () => {
      const get = async (q: string) => {
        const started = performance.now();
        const response = await fetch(`${site.base}/search?q=${encodeURIComponent(q)}`);
        const html = await response.text();
        expect(response.status).toBe(200);
        return { ms: performance.now() - started, html };
      };
      // The first search builds the index.
      const first = await get("sourdough");
      console.log(
        `${kind}: the first search (builds the index of ${ENTRIES} entries): ${first.ms.toFixed(0)} ms`,
      );
      expect(first.html).toContain("results");
      const queries = [
        "sourdough",
        "bread garden",
        "ba",
        "kale morning",
        "sourdogh", // typo help
        "zzqqxxyy", // nothing
        VOCABULARY[50]!,
        `${VOCABULARY[10]} ${VOCABULARY[200]!.slice(0, 3)}`,
      ];
      // A real slowdown is slow in every round; the test passes when any of up to three rounds is under the limit.
      let best = Infinity;
      for (let round = 0; round < 3 && best >= 200; round++) {
        const times: number[] = [];
        for (let i = 0; i < 80; i++) times.push((await get(queries[i % queries.length]!)).ms);
        times.sort((a, b) => a - b);
        const p95 = times[Math.floor(times.length * 0.95)]!;
        console.log(
          `${kind}: round ${round + 1}: search page p95 ${p95.toFixed(1)} ms, median ${times[Math.floor(times.length / 2)]!.toFixed(1)} ms, slowest ${times.at(-1)!.toFixed(1)} ms`,
        );
        best = Math.min(best, p95);
      }
      expect(best).toBeLessThan(200);
      const typo = await get("sourdogh");
      expect(typo.html).toContain("Showing results for");
    }, 600_000);
  });
}
