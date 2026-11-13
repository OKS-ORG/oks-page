import { describe, expect, test } from "vitest";
import {
  formatInZone,
  isValidTimeZone,
  timeZoneNames,
  utcToZonedLocal,
  zonedLocalToUtc,
} from "./timezone.js";

const utc = (s: string) => Date.parse(s);

describe("time zone names", () => {
  test("real names are valid; made-up, empty and very long ones are not", () => {
    for (const ok of [
      "UTC",
      "Asia/Kolkata",
      "America/New_York",
      "Europe/Berlin",
      "Pacific/Chatham",
    ])
      expect(isValidTimeZone(ok), ok).toBe(true);
    for (const bad of ["", "Mars/Base", "asia kolkata", "x".repeat(65), "+05:30 ", "../etc"])
      expect(isValidTimeZone(bad), JSON.stringify(bad)).toBe(false);
    expect(isValidTimeZone(5 as never)).toBe(false);
  });
  test("the list starts with UTC, has no duplicates and holds the common zones", () => {
    const names = timeZoneNames();
    expect(names[0]).toBe("UTC");
    expect(new Set(names).size).toBe(names.length);
    for (const zone of ["Asia/Kolkata", "America/New_York", "Europe/London", "Australia/Sydney"])
      expect(names).toContain(zone);
    for (const zone of names) expect(isValidTimeZone(zone), zone).toBe(true);
  });
});

describe("a moment as a date and time box, and back", () => {
  test("whole-hour, half-hour and quarter-hour zones, east and west of UTC", () => {
    const moment = utc("2026-11-12T10:15:00Z");
    expect(utcToZonedLocal(moment, "UTC")).toBe("2026-11-12T10:15");
    expect(utcToZonedLocal(moment, "Asia/Kolkata")).toBe("2026-11-12T15:45"); // +5:30
    expect(utcToZonedLocal(moment, "Pacific/Chatham")).toBe("2026-11-13T00:00"); // +13:45 in summer, and the date changes
    expect(utcToZonedLocal(moment, "America/New_York")).toBe("2026-11-12T05:15"); // -5 in November
    expect(utcToZonedLocal(moment, "Pacific/Honolulu")).toBe("2026-11-12T00:15");
    expect(utcToZonedLocal(moment, "Asia/Tokyo")).toBe("2026-11-12T19:15"); // the date can change
  });

  test("typing a time in a zone gives the right moment, and showing it again gives the same box", () => {
    for (const [zone, local, expected] of [
      ["UTC", "2026-11-12T09:30", "2026-11-12T09:30:00Z"],
      ["Asia/Kolkata", "2026-11-12T09:30", "2026-11-12T04:00:00Z"],
      ["America/New_York", "2026-11-12T09:30", "2026-11-12T14:30:00Z"],
      ["America/New_York", "2026-07-12T09:30", "2026-07-12T13:30:00Z"], // summer time
      ["Australia/Sydney", "2026-11-12T09:30", "2026-11-11T22:30:00Z"], // summer time, +11
      ["Australia/Lord_Howe", "2026-01-15T12:00", "2026-01-15T01:00:00Z"], // a 30-minute clock change: +11
      ["Pacific/Chatham", "2026-11-12T09:30", "2026-11-11T19:45:00Z"], // +13:45 in summer
      ["Asia/Tokyo", "2026-01-01T00:00", "2025-12-31T15:00:00Z"], // across the new year
    ] as const) {
      const ms = zonedLocalToUtc(local, zone);
      expect(ms, `${zone} ${local}`).toBe(utc(expected));
      expect(utcToZonedLocal(ms!, zone), `${zone} ${local} back`).toBe(local);
    }
  });

  test("clock changes: the missing hour in spring jumps forward, the repeated hour in autumn takes the earlier moment", () => {
    // New York, 8 March 2026: at 02:00 the clocks go to 03:00, so 02:30 does not exist.
    const gap = zonedLocalToUtc("2026-03-08T02:30", "America/New_York");
    expect(utcToZonedLocal(gap!, "America/New_York")).toBe("2026-03-08T03:30");
    // 1 November 2026: at 02:00 the clocks go back to 01:00, so 01:30 happens twice (05:30Z, then 06:30Z).
    const twice = zonedLocalToUtc("2026-11-01T01:30", "America/New_York");
    expect(twice).toBe(utc("2026-11-01T05:30:00Z"));
    // The times either side are ordinary.
    expect(zonedLocalToUtc("2026-11-01T00:30", "America/New_York")).toBe(
      utc("2026-11-01T04:30:00Z"),
    );
    expect(zonedLocalToUtc("2026-11-01T03:30", "America/New_York")).toBe(
      utc("2026-11-01T08:30:00Z"),
    );
  });

  test("values that are not a date and time give nothing", () => {
    for (const bad of [
      "",
      "tomorrow",
      "2026-11-12",
      "2026-11-12 09:30",
      "2026-11-12T09:30:00",
      "2026-02-30T09:30", // February 30
      "2026-13-01T09:30",
      "2026-11-12T24:00",
      "2026-11-12T09:60",
      "26-11-12T09:30",
    ])
      expect(zonedLocalToUtc(bad, "UTC"), JSON.stringify(bad)).toBeNull();
  });

  test("a leap day is real", () => {
    expect(zonedLocalToUtc("2028-02-29T12:00", "UTC")).toBe(utc("2028-02-29T12:00:00Z"));
    expect(zonedLocalToUtc("2027-02-29T12:00", "UTC")).toBeNull();
  });
});

describe("a moment written for people", () => {
  test("it is in the zone's own time, whoever looks", () => {
    const moment = utc("2026-11-12T22:30:00Z");
    expect(formatInZone(moment, "UTC")).toBe("Nov 12, 2026, 10:30 PM");
    expect(formatInZone(moment, "Asia/Kolkata")).toBe("Nov 13, 2026, 4:00 AM");
    expect(formatInZone(moment, "America/Los_Angeles", { dateStyle: "long" })).toBe(
      "November 12, 2026",
    );
  });
});
