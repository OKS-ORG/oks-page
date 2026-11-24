// The opening hours block as the page writes it (spec 19, section 4): the week as a table with a row for every day, special
// days, the hours for the page script in one attribute, text escaped, and nothing drawn when there is nothing safe to draw.
import { checkBlocks, type Block } from "@oks-page/content-safety";
import { describe, expect, test } from "vitest";
import { pageCss, writeBlocks } from "./index.js";

const hours = (props: Record<string, unknown>): Block => ({
  id: "h1",
  type: "openingHours",
  props,
  content: null,
  children: [],
});
const write = (...blocks: Block[]) =>
  writeBlocks(checkBlocks({ version: 1, blocks } as never).body.blocks);
const good = {
  title: "When we are open",
  tz: "Europe/Berlin",
  week: [
    { day: 0, times: [["09:00", "17:00"]] },
    {
      day: 5,
      times: [
        ["10:00", "12:00"],
        ["13:00", "24:00"],
      ],
    },
  ],
  special: [{ date: "2026-12-25", note: "Christmas <Day>", times: [] }],
};

describe("the opening hours block", () => {
  test("a table with a row for every day, closed days said, times in order, and a title as the caption", () => {
    const { html } = write(hours(good));
    expect(html).toContain('<div class="opening-hours"');
    expect(html).toContain("<caption>When we are open</caption>");
    expect(html).toContain('<tr data-day="0"><th scope="row">Monday</th><td>09:00–17:00</td></tr>');
    expect(html).toContain('<tr data-day="1"><th scope="row">Tuesday</th><td>Closed</td></tr>');
    expect(html).toContain("<td>10:00–12:00, 13:00–00:00</td>");
    expect(html).toContain('<tr data-day="6"><th scope="row">Sunday</th><td>Closed</td></tr>');
  });

  test("special days are listed with their note, escaped, and the hours go to the page script in one attribute", () => {
    const { html } = write(hours(good));
    expect(html).toContain(
      '<li data-date="2026-12-25">25 Dec 2026: Closed (Christmas &lt;Day&gt;)</li>',
    );
    expect(html).not.toContain("<Day>");
    const data = /data-hours="([^"]+)"/
      .exec(html)![1]!
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    expect(JSON.parse(data)).toMatchObject({ tz: "Europe/Berlin", week: [{ day: 0 }, { day: 5 }] });
    // The line the script fills in is hidden until it has something true to say.
    expect(html).toContain('<p class="open-now" hidden></p>');
  });

  test("a title that is left out says 'Opening hours'; bad settings draw nothing", () => {
    expect(write(hours({ ...good, title: "" })).html).toContain("<caption>Opening hours</caption>");
    expect(write(hours({ ...good, tz: "Mars/Olympus" })).html).toBe("");
    expect(write(hours({ tz: "Europe/Berlin" })).html).toBe("");
  });

  test("the words of the block are searchable and the page carries its styles only when it has the block", () => {
    expect(write(hours(good)).plainText).toContain("When we are open");
    expect(
      pageCss(checkBlocks({ version: 1, blocks: [hours(good)] } as never).body.blocks),
    ).toContain(".opening-hours");
    expect(pageCss([])).not.toContain(".opening-hours");
  });
});
