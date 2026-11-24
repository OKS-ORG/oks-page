// The opening hours block (spec 19, section 4): what is kept of its settings, and that the block checks apply the same rules.
import { describe, expect, test } from "vitest";
import { checkBlocks } from "./index.js";
import { isRealDate, isTimeZone, readHours } from "./hours.js";

const good = {
  tz: "Europe/Berlin",
  week: [
    { day: 0, times: [["09:00", "17:00"]] },
    {
      day: 4,
      times: [
        ["09:00", "12:00"],
        ["13:00", "24:00"],
      ],
    },
  ],
  special: [{ date: "2026-12-25", note: "Christmas Day", times: [] }],
};

describe("what is kept", () => {
  test("good hours are kept as they are, sorted", () => {
    expect(readHours({ ...good, title: "When we are open" })).toEqual({
      title: "When we are open",
      ...good,
    });
    const sorted = readHours({
      tz: "Asia/Kolkata",
      week: [
        { day: 5, times: [["10:00", "11:00"]] },
        {
          day: 1,
          times: [
            ["13:00", "14:00"],
            ["09:00", "10:00"],
          ],
        },
      ],
      special: [],
    });
    expect(sorted?.week.map((d) => d.day)).toEqual([1, 5]);
    expect(sorted?.week[0]?.times).toEqual([
      ["09:00", "10:00"],
      ["13:00", "14:00"],
    ]);
  });

  test.each([
    ["no time zone", { ...good, tz: undefined }],
    ["a time zone nobody knows", { ...good, tz: "Mars/Olympus" }],
    ["nothing at all", { tz: "Europe/Berlin", week: [], special: [] }],
    [
      "only days that do not exist",
      { tz: "Europe/Berlin", week: [{ day: 7, times: [["09:00", "17:00"]] }], special: [] },
    ],
  ])("%s leaves nothing to draw", (_name, raw) => {
    expect(readHours(raw as Record<string, unknown>)).toBeNull();
  });

  test("bad times, repeated days and overlaps are dropped, and no day has more than four times", () => {
    const r = readHours({
      tz: "Europe/Berlin",
      week: [
        {
          day: 2,
          times: [
            ["09:00", "12:00"],
            ["11:00", "13:00"], // overlaps the first
            ["14:00", "13:00"], // ends before it starts
            ["25:00", "26:00"],
            ["09:5", "10:00"],
            ["15:00", "24:00"],
            ["24:00", "24:00"],
            "not a pair",
          ],
        },
        { day: 2, times: [["01:00", "02:00"]] }, // the same day again: the first entry wins
        { day: 1.5, times: [["09:00", "10:00"]] },
        {
          day: 3,
          times: [
            ["00:00", "01:00"],
            ["02:00", "03:00"],
            ["04:00", "05:00"],
            ["06:00", "07:00"],
            ["08:00", "09:00"],
          ],
        },
      ],
      special: [],
    });
    expect(r?.week).toEqual([
      {
        day: 2,
        times: [
          ["09:00", "12:00"],
          ["15:00", "24:00"],
        ],
      },
      {
        day: 3,
        times: [
          ["00:00", "01:00"],
          ["02:00", "03:00"],
          ["04:00", "05:00"],
          ["06:00", "07:00"],
        ],
      },
    ]);
  });

  test("special days are real calendar days, once each, with a short plain note", () => {
    const r = readHours({
      ...good,
      special: [
        { date: "2026-02-30", note: "no such day", times: [] },
        { date: "2026-12-24", note: "Short day\n<b>x</b>", times: [["10:00", "12:00"]] },
        { date: "2026-12-24", note: "twice", times: [] },
        { date: "26-12-24", note: "wrong shape", times: [] },
        { date: "2026-12-26", note: "x".repeat(200), times: [] },
      ],
    });
    expect(r?.special.map((s) => s.date)).toEqual(["2026-12-24", "2026-12-26"]);
    expect(r?.special[0]?.note).toBe("Short day <b>x</b>");
    expect(r?.special[1]?.note.length).toBe(80);
    expect(isRealDate("2028-02-29")).toBe(true);
    expect(isRealDate("2027-02-29")).toBe(false);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("the block checks", () => {
  const block = (props: Record<string, unknown>) => ({
    id: "h1",
    type: "openingHours",
    props,
    content: null,
    children: [],
  });

  test("an opening hours block with good settings is kept, with bad parts cleaned", () => {
    const r = checkBlocks({ version: 1, blocks: [block({ ...good, junk: 1 })] });
    const props = (r.body.blocks[0] as { props: Record<string, unknown> }).props;
    expect(props["tz"]).toBe("Europe/Berlin");
    expect((props["week"] as unknown[]).length).toBe(2);
  });

  test("one with nothing safe to draw loses its settings and is reported", () => {
    const r = checkBlocks({
      version: 1,
      blocks: [block({ tz: "Mars/Olympus", week: [{ day: 0, times: [["09:00", "17:00"]] }] })],
    });
    const props = (r.body.blocks[0] as { props: Record<string, unknown> }).props;
    expect(props["week"]).toBeUndefined();
    expect(props["tz"]).toBeUndefined();
  });
});
