// Visitor statistics (spec 18, section 3; PR-04): counting without cookies and without keeping an address. The pure parts
// (the daily secret, the hash, the kind of device, robots, where a visit came from) and, in SQLite and PostgreSQL, the totals,
// the once-a-day count of a visitor, the report, the on/off setting and the clean-up.
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { purgeStatistics } from "./keeping.js";
import {
  countryOf,
  dailySecret,
  deviceOf,
  isBot,
  loadStatistics,
  recordViews,
  saveStatisticsEnabled,
  sourceOf,
  statDayOf,
  statisticsEnabled,
  visitorHash,
  type StatView,
} from "./statistics.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000158";
const SITE2 = "SITE0000000000000000000159";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const admin: Actor = { userId: "USER0000000000000000000158", can: (c) => c === "settings.manage" };
const nobody: Actor = { userId: "USER0000000000000000000158", can: () => false };
const SECRET = "s".repeat(40);

describe("who is counted, and how", () => {
  test("the secret changes every day and for each site, and so does the visitor's hash", () => {
    const a = dailySecret(SECRET, SITE, "2026-11-24");
    expect(dailySecret(SECRET, SITE, "2026-11-24")).toBe(a);
    expect(dailySecret(SECRET, SITE, "2026-11-25")).not.toBe(a);
    expect(dailySecret(SECRET, SITE2, "2026-11-24")).not.toBe(a);
    expect(dailySecret("t".repeat(40), SITE, "2026-11-24")).not.toBe(a);
    const h = visitorHash(a, "203.0.113.7", "Firefox");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(visitorHash(a, "203.0.113.7", "Firefox")).toBe(h);
    // The same visitor is another hash the next day: nobody can be followed.
    expect(visitorHash(dailySecret(SECRET, SITE, "2026-11-25"), "203.0.113.7", "Firefox")).not.toBe(
      h,
    );
    expect(visitorHash(a, "203.0.113.8", "Firefox")).not.toBe(h);
    expect(visitorHash(a, "203.0.113.7", "Chrome")).not.toBe(h);
    expect(h).not.toContain("203");
  });

  test.each([
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/120", "desktop"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17) Mobile/15E148", "mobile"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537", "mobile"],
    ["Mozilla/5.0 (iPad; CPU OS 17) Safari", "tablet"],
    ["Mozilla/5.0 (Linux; Android 13; SM-X700) Safari/537", "tablet"],
  ])("%s is a %s", (ua, device) => {
    expect(deviceOf(ua)).toBe(device);
  });

  test("robots, tools and a missing browser name are not people", () => {
    for (const ua of [
      "",
      "Googlebot/2.1",
      "curl/8.5",
      "Mozilla/5.0 (compatible; bingbot/2.0)",
      "python-requests/2.31",
      "Lighthouse",
    ])
      expect(isBot(ua), ua).toBe(true);
    expect(isBot("Mozilla/5.0 (Windows NT 10.0) Chrome/120")).toBe(false);
  });

  test("a visit came from a search engine, another site or nowhere; only the host is kept", () => {
    expect(sourceOf("https://www.google.com/search?q=secret+words", "garden.example")).toEqual({
      kind: "search",
      key: "Google",
    });
    expect(sourceOf("https://duckduckgo.com/?q=x", "garden.example")).toEqual({
      kind: "search",
      key: "DuckDuckGo",
    });
    expect(sourceOf("https://news.example.org/story/42?a=b", "garden.example")).toEqual({
      kind: "referrer",
      key: "news.example.org",
    });
    expect(sourceOf("https://www.garden.example/about", "garden.example:3000")).toBeNull();
    expect(sourceOf("https://garden.example/about", "www.garden.example")).toBeNull();
    expect(sourceOf(null, "garden.example")).toBeNull();
    expect(sourceOf("", "garden.example")).toBeNull();
    expect(sourceOf("not a url", "garden.example")).toBeNull();
    expect(sourceOf("android-app://com.google.android.gm", "garden.example")).toBeNull();
  });

  test("the country comes from what a host or CDN says, and only when it is a real code", () => {
    const from = (h: Record<string, string>) => countryOf((n) => h[n] ?? null);
    expect(from({ "cf-ipcountry": "de" })).toBe("DE");
    expect(from({ "x-vercel-ip-country": "FR" })).toBe("FR");
    expect(from({ "cf-ipcountry": "XX", "x-country-code": "SE" })).toBe("SE");
    expect(from({ "cf-ipcountry": "T1" })).toBe("");
    expect(from({ "cf-ipcountry": "Germany" })).toBe("");
    expect(from({})).toBe("");
    expect(statDayOf(NOW)).toBe("2026-11-24");
  });
});

const view = (over: Partial<StatView> = {}): StatView => ({
  day: "2026-11-24",
  hash: "a".repeat(32),
  path: "/",
  source: null,
  country: "",
  device: "desktop",
  ...over,
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: visitor statistics`, () => {
    let db: TestDb;
    const dailyRows = () =>
      db.runner.all(
        `select "day", "kind", "key", "count" from "stats_daily" where "site_id" = ? order by "day", "kind", "key"`,
        [SITE],
      );

    beforeEach(async () => {
      db = await open();
      for (const id of [SITE, SITE2])
        await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
          id,
          T,
          T,
        ]);
    });

    test("a page view counts every time, a visitor once a day, with one count for their source, country and device", async () => {
      await recordViews(db.runner, SITE, [
        view({
          path: "/",
          source: { kind: "search", key: "Google" },
          country: "DE",
          device: "mobile",
        }),
        view({ path: "/about" }),
        view({ path: "/about" }),
        view({
          hash: "b".repeat(32),
          path: "/about",
          source: { kind: "referrer", key: "news.example.org" },
          country: "DE",
        }),
      ]);
      const rows = Object.fromEntries(
        (await dailyRows()).map((r) => [
          `${String(r["kind"])}:${String(r["key"])}`,
          Number(r["count"]),
        ]),
      );
      expect(rows).toEqual({
        "views:": 4,
        "visitors:": 2,
        "page:/": 1,
        "page:/about": 3,
        "search:Google": 1,
        "referrer:news.example.org": 1,
        "country:DE": 2,
        "device:mobile": 1,
        "device:desktop": 1,
      });
      // Another batch the same day adds to the totals and does not count the same visitor again.
      await recordViews(db.runner, SITE, [view({ path: "/contact" })]);
      const again = Object.fromEntries(
        (await dailyRows()).map((r) => [
          `${String(r["kind"])}:${String(r["key"])}`,
          Number(r["count"]),
        ]),
      );
      expect(again["views:"]).toBe(5);
      expect(again["visitors:"]).toBe(2);
      expect(again["page:/contact"]).toBe(1);
      // The next day the same hash is a new visitor; another site is not touched.
      await recordViews(db.runner, SITE, [view({ day: "2026-11-25" })]);
      expect(
        (await dailyRows())
          .filter((r) => r["kind"] === "visitors")
          .map((r) => [r["day"], Number(r["count"])]),
      ).toEqual([
        ["2026-11-24", 2],
        ["2026-11-25", 1],
      ]);
      expect(
        (await db.runner.all(`select 1 from "stats_daily" where "site_id" = ?`, [SITE2])).length,
      ).toBe(0);
    });

    test("nothing but totals and hashes of the day is kept: no address, no browser name, no query", async () => {
      await recordViews(db.runner, SITE, [
        view({
          hash: visitorHash(dailySecret(SECRET, SITE, "2026-11-24"), "203.0.113.7", "Firefox/120"),
        }),
      ]);
      const all = JSON.stringify([
        await db.runner.all(`select * from "stats_daily"`),
        await db.runner.all(`select * from "stats_seen"`),
      ]);
      expect(all).not.toContain("203.0.113");
      expect(all).not.toContain("Firefox");
      const seen = await db.runner.all(`select "hash" from "stats_seen"`);
      expect(seen.map((r) => String(r["hash"]).length)).toEqual([32]);
    });

    test("the report covers every day of the range, sums the kinds and lists the most counted first", async () => {
      const day = (n: number) => statDayOf(NOW - n * DAY);
      await recordViews(db.runner, SITE, [
        view({ day: day(0), hash: "1".repeat(32), path: "/a", country: "DE", device: "mobile" }),
        view({ day: day(0), hash: "1".repeat(32), path: "/a" }),
        view({
          day: day(0),
          hash: "2".repeat(32),
          path: "/b",
          country: "DE",
          source: { kind: "search", key: "Bing" },
        }),
        view({ day: day(2), hash: "1".repeat(32), path: "/b", country: "FR" }),
        view({ day: day(40), hash: "3".repeat(32), path: "/old" }),
      ]);
      const week = await loadStatistics(db.runner, SITE, 7, NOW);
      expect(week.days.length).toBe(7);
      expect(week.days[6]).toEqual({ day: day(0), views: 3, visitors: 2 });
      expect(week.days[4]).toEqual({ day: day(2), views: 1, visitors: 1 });
      expect(week.days[0]).toEqual({ day: day(6), views: 0, visitors: 0 });
      expect([week.views, week.visitors]).toEqual([4, 3]);
      expect(week.pages).toEqual([
        { key: "/a", count: 2 },
        { key: "/b", count: 2 },
      ]);
      expect(week.countries).toEqual([
        { key: "DE", count: 2 },
        { key: "FR", count: 1 },
      ]);
      expect(week.searches).toEqual([{ key: "Bing", count: 1 }]);
      expect(week.referrers).toEqual([]);
      expect(week.devices[0]).toEqual({ key: "desktop", count: 2 });
      // The page that is 40 days old is only in a longer range, and a range is kept sensible.
      expect((await loadStatistics(db.runner, SITE, 30, NOW)).views).toBe(4);
      expect((await loadStatistics(db.runner, SITE, 90, NOW)).views).toBe(5);
      expect((await loadStatistics(db.runner, SITE, -5, NOW)).days.length).toBe(7);
      expect((await loadStatistics(db.runner, SITE2, 7, NOW)).views).toBe(0);
    });

    test("counting is on until the owner switches it off; only people who manage the settings may, and only on or off", async () => {
      expect(await statisticsEnabled(db.runner, SITE)).toBe(true);
      expect((await saveStatisticsEnabled(db.runner, admin, SITE, false)).ok).toBe(true);
      expect(await statisticsEnabled(db.runner, SITE)).toBe(false);
      expect(await statisticsEnabled(db.runner, SITE2)).toBe(true);
      const no = await saveStatisticsEnabled(db.runner, nobody, SITE, true);
      expect(!no.ok && no.code).toBe("forbidden");
      for (const bad of ["yes", 1, null, undefined]) {
        const r = await saveStatisticsEnabled(db.runner, admin, SITE, bad);
        expect(!r.ok && r.code).toBe("invalid");
      }
      expect(await statisticsEnabled(db.runner, SITE)).toBe(false);
      await saveStatisticsEnabled(db.runner, admin, SITE, true);
      expect(await statisticsEnabled(db.runner, SITE)).toBe(true);
    });

    test("the clean-up deletes totals older than the keeping time, and the marks of earlier days", async () => {
      const day = (n: number) => statDayOf(NOW - n * DAY);
      await recordViews(db.runner, SITE, [
        view({ day: day(0), hash: "1".repeat(32) }),
        view({ day: day(729), hash: "2".repeat(32) }),
        view({ day: day(730), hash: "3".repeat(32) }),
      ]);
      expect(await purgeStatistics(db.runner, SITE, 730, () => NOW)).toBe(
        // views, visitors, page and device of the 730-day-old day
        4,
      );
      expect(new Set((await dailyRows()).map((r) => String(r["day"])))).toEqual(
        new Set([day(0), day(729)]),
      );
      // Only today's marks are left.
      expect(
        (await db.runner.all(`select "day" from "stats_seen"`)).map((r) => String(r["day"])),
      ).toEqual([day(0)]);
    });
  });
}
