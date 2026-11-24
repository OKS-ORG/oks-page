// The Business plugin (spec 19): the details and hours it reads from its settings, the three blocks it draws (checked and
// written by the core like any block), and that the plugin and the site read the same text the same way.
import { checkBlocks } from "@oks-page/content-safety";
import { writeBlocks } from "@oks-page/renderer";
import { describe, expect, test } from "vitest";
import {
  parseSpecialDays as siteSpecial,
  parseTimes as siteTimes,
  readBusiness,
} from "../../../packages/core/src/business.js";
import { readPluginFile } from "../../../packages/sandbox/src/index.js";
import plugin, { parseSpecialDays, parseTimes } from "../src/index.js";
import file from "../../../packages/oks-page/src/business-plugin-file.json";

type Ctx = { settings: { get: (key: string) => Promise<unknown> } };
const ctx = (values: Record<string, unknown>): Ctx => ({
  settings: { get: async (key) => values[key] ?? null },
});
const render = (block: string, props: Record<string, unknown>, values: Record<string, unknown>) =>
  (plugin.blocks as Record<string, { render: (p: unknown, c: Ctx) => Promise<unknown> }>)[
    block
  ]!.render(props, ctx(values));
const page = async (node: unknown) =>
  writeBlocks(checkBlocks({ version: 1, blocks: [node] } as never).body.blocks).html;

const SETTINGS = {
  name: "Weber Garden Cafe",
  type: "Cafe",
  street: "Lindenstrasse 4",
  postal: "10115",
  city: "Berlin",
  country: "de",
  phone: "+49 30 1234567",
  email: "hello@weber.example",
  time_zone: "Europe/Berlin",
  hours_mon: "09:00-17:00",
  hours_tue: "9:00 - 12:00, 13:00-17:00",
  hours_fri: "10:00-24:00",
  special_days: "2026-12-25 closed Christmas Day; 2026-12-24 09:00-12:00 Christmas Eve",
};

describe("the shipped plugin file", () => {
  test("is a valid plugin file that offers the five blocks", () => {
    const read = readPluginFile(JSON.stringify(file));
    expect(read.ok ? "" : read.message).toBe("");
    if (!read.ok) return;
    expect(read.file.manifest.id).toBe("business");
    expect([...read.file.manifest.permissions].sort()).toEqual([
      "admin:pages",
      "email:send",
      "routes:public",
    ]);
    expect(read.file.manifest.blocks).toEqual([
      "opening-hours",
      "contact-details",
      "payment-link",
      "reviews",
      "booking",
    ]);
    expect(Object.keys(read.file.manifest.settings ?? {})).toContain("hours_sun");
  });
});

describe("reading the text of the settings", () => {
  test.each([
    ["09:00-17:00", [["09:00", "17:00"]]],
    [
      "9:00 - 12:00, 13:00–17:30",
      [
        ["09:00", "12:00"],
        ["13:00", "17:30"],
      ],
    ],
    ["10:00-24:00", [["10:00", "24:00"]]],
    ["", []],
    ["closed", []],
    ["17:00-09:00", []],
    ["25:00-26:00", []],
    [
      "09:00-12:00, nonsense, 14:00-15:00",
      [
        ["09:00", "12:00"],
        ["14:00", "15:00"],
      ],
    ],
  ])("%j gives %j, the same for the plugin and the site", (text, expected) => {
    expect(parseTimes(text)).toEqual(expected);
    expect(siteTimes(text)).toEqual(expected);
  });

  test("special days: closed days and shorter days, with notes; bad ones are dropped; the same for the plugin and the site", () => {
    const text =
      "2026-12-25 closed Christmas Day; 2026-12-24 09:00-12:00 Christmas Eve; 2026-02-30 closed; nonsense; 2026-12-31 closed";
    const expected = [
      { date: "2026-12-25", note: "Christmas Day", times: [] },
      { date: "2026-12-24", note: "Christmas Eve", times: [["09:00", "12:00"]] },
      { date: "2026-12-31", note: "", times: [] },
    ];
    expect(parseSpecialDays(text)).toEqual(expected);
    expect(siteSpecial(text)).toEqual(expected);
  });
});

describe("the blocks", () => {
  test("opening hours: the core's own block, with the week and the special days, drawn as a table", async () => {
    const node = await render("opening-hours", { title: "When we are open" }, SETTINGS);
    expect(node).toMatchObject({
      type: "openingHours",
      props: { tz: "Europe/Berlin", title: "When we are open" },
    });
    const html = await page(node);
    expect(html).toContain("<caption>When we are open</caption>");
    expect(html).toContain('<th scope="row">Tuesday</th><td>09:00–12:00, 13:00–17:00</td>');
    expect(html).toContain('<th scope="row">Wednesday</th><td>Closed</td>');
    expect(html).toContain("25 Dec 2026: Closed (Christmas Day)");
  });

  test("opening hours draw nothing without a time zone or without any hours", async () => {
    expect(await render("opening-hours", {}, { ...SETTINGS, time_zone: "" })).toBeNull();
    expect(await render("opening-hours", {}, { name: "x", time_zone: "Europe/Berlin" })).toBeNull();
  });

  test("contact details: name, address, a phone link and an email link; nothing else", async () => {
    const html = await page(await render("contact-details", { title: "Find us" }, SETTINGS));
    expect(html).toContain("<h2");
    expect(html).toContain("Find us");
    expect(html).toContain("<strong>Weber Garden Cafe</strong>");
    expect(html).toContain("Lindenstrasse 4, 10115 Berlin, DE");
    expect(html).toContain('href="tel:+49301234567"');
    expect(html).toContain('href="mailto:hello@weber.example"');
    expect(await render("contact-details", {}, {})).toBeNull();
  });

  test("an email that is not one is not made a link, and text is escaped", async () => {
    const html = await page(
      await render("contact-details", {}, { name: "A <b>&</b> B", email: "not an email" }),
    );
    expect(html).not.toContain("mailto:");
    expect(html).toContain("A &lt;b&gt;&amp;&lt;/b&gt; B");
  });

  test("payment link: a button to the owner's https page, with a note; no card field anywhere (BZ-06)", async () => {
    const html = await page(
      await render(
        "payment-link",
        {
          label: "Pay your bill",
          url: "https://pay.example.com/weber",
          note: "Secure payment by our provider.",
        },
        {},
      ),
    );
    expect(html).toContain('href="https://pay.example.com/weber"');
    expect(html).toContain(">Pay your bill</a>");
    expect(html).toContain("Secure payment by our provider.");
    expect(html).not.toMatch(/<input|<form|card/i);
    // The default words, and only https.
    expect(
      await page(await render("payment-link", { url: "https://pay.example.com/x" }, {})),
    ).toContain(">Pay now</a>");
    for (const url of [
      "http://pay.example.com/x",
      "javascript:alert(1)",
      "//pay.example.com",
      "",
      "https://a b",
    ])
      expect(await render("payment-link", { url }, {})).toBeNull();
  });
});

describe("what the site reads from the same settings", () => {
  test("a business with a name and what was entered; without a name there is nothing to say", () => {
    const b = readBusiness(SETTINGS);
    expect(b).toMatchObject({
      name: "Weber Garden Cafe",
      type: "Cafe",
      city: "Berlin",
      country: "DE",
      email: "hello@weber.example",
    });
    expect(b?.week.map((d) => d.day)).toEqual([0, 1, 4]);
    expect(readBusiness({ ...SETTINGS, name: "  " })).toBeNull();
    expect(readBusiness({})).toBeNull();
  });
});
