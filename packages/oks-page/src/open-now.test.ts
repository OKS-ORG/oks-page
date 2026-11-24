// "Open now" (spec 19, section 4; BZ-02): right in the business's own time zone, whatever the visitor's, with special days
// over the week's hours. Fixed moments, so the tests do not depend on the machine's clock or time zone.
import { describe, expect, test } from "vitest";
import { localParts, openNow, type OpenHours } from "./open-now";

const berlin: OpenHours = {
  tz: "Europe/Berlin",
  week: [
    { day: 0, times: [["09:00", "17:00"]] }, // Monday
    {
      day: 1,
      times: [
        ["09:00", "12:00"],
        ["13:00", "17:00"],
      ],
    },
    { day: 4, times: [["10:00", "24:00"]] },
  ],
  special: [
    { date: "2026-12-25", note: "Christmas Day", times: [] },
    { date: "2026-12-24", note: "Christmas Eve", times: [["09:00", "12:00"]] },
  ],
};

// 2026-11-23 is a Monday. Berlin is one hour ahead of UTC in winter.
const at = (iso: string) => Date.parse(iso);

describe("the time in the business's own zone", () => {
  test("the same moment is another day in another zone", () => {
    const ms = at("2026-11-23T23:30:00Z");
    expect(localParts(ms, "Europe/Berlin")).toEqual({ date: "2026-11-24", day: 1, minutes: 30 });
    expect(localParts(ms, "America/New_York")).toEqual({
      date: "2026-11-23",
      day: 0,
      minutes: 18 * 60 + 30,
    });
    expect(localParts(ms, "Asia/Kolkata")).toEqual({ date: "2026-11-24", day: 1, minutes: 5 * 60 });
    // Midnight is 00:xx, never 24:xx.
    expect(localParts(at("2026-11-23T23:00:00Z"), "Europe/Berlin").minutes).toBe(0);
  });
});

describe("open now", () => {
  test("inside a time of the day it is open, until the end of that time", () => {
    expect(openNow(berlin, at("2026-11-23T10:00:00Z"))).toMatchObject({
      open: true,
      text: "Open now, until 17:00",
      day: 0,
    });
    // The first minute counts, the last minute does not.
    expect(openNow(berlin, at("2026-11-23T08:00:00Z")).open).toBe(true);
    expect(openNow(berlin, at("2026-11-23T15:59:00Z")).open).toBe(true);
    expect(openNow(berlin, at("2026-11-23T16:00:00Z")).open).toBe(false);
  });

  test("a day that ends at midnight is open until the end of the day", () => {
    const friday = at("2026-11-27T22:30:00Z"); // 23:30 in Berlin
    expect(openNow(berlin, friday)).toMatchObject({ open: true, text: "Open now, until 00:00" });
    expect(openNow(berlin, friday + 31 * 60_000).open).toBe(false);
  });

  test("closed says when it opens next: later today, tomorrow, or a named day", () => {
    // Tuesday lunch break.
    expect(openNow(berlin, at("2026-11-24T11:30:00Z")).text).toBe(
      "Closed now, opens today at 13:00",
    );
    // Monday evening: tomorrow at 09:00.
    expect(openNow(berlin, at("2026-11-23T17:00:00Z")).text).toBe(
      "Closed now, opens tomorrow at 09:00",
    );
    // Tuesday evening: nothing on Wednesday or Thursday, so Friday.
    expect(openNow(berlin, at("2026-11-24T17:00:00Z")).text).toBe(
      "Closed now, opens Friday at 10:00",
    );
  });

  test("another time zone than the visitor's: Berlin is already closed when New York is at lunch", () => {
    // 12:00 in New York (UTC-5) is 18:00 in Berlin, after closing on Monday.
    const r = openNow(berlin, at("2026-11-23T17:00:00Z"));
    expect(r.open).toBe(false);
    expect(r.date).toBe("2026-11-23");
  });

  test("a special day replaces the week's hours: closed all day, or other hours", () => {
    // Friday 25 December: closed, with its note.
    expect(openNow(berlin, at("2026-12-25T09:00:00Z")).text).toBe(
      "Closed now (Christmas Day), opens Monday at 09:00",
    );
    // Thursday 24 December: only until 12:00.
    expect(openNow(berlin, at("2026-12-24T09:00:00Z"))).toMatchObject({
      open: true,
      text: "Open now, until 12:00",
    });
    expect(openNow(berlin, at("2026-12-24T12:00:00Z")).open).toBe(false);
  });

  test("a business with no hours at all is just closed", () => {
    expect(openNow({ tz: "UTC", week: [], special: [] }, at("2026-11-23T10:00:00Z")).text).toBe(
      "Closed now",
    );
  });
});
