// Booking requests in the Business plugin (spec 19, section 7; BZ-04, BZ-05): only free times inside the opening hours are
// offered and accepted, a request waits for the owner, the visitor is emailed when it is confirmed or declined, and the private
// calendar shows confirmed bookings to whoever has its secret address. Runs with a plain in-memory store and a fixed clock.
import { checkBlocks } from "@oks-page/content-safety";
import { writeBlocks } from "@oks-page/renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import plugin, { freeSlots, parseServices, partsIn, zonedToMs } from "../src/index.js";

type Row = { key: string; value: Record<string, unknown> };
function memory(settings: Record<string, unknown>) {
  const data = new Map<string, Map<string, unknown>>();
  const col = (c: string) => data.get(c) ?? data.set(c, new Map()).get(c)!;
  const mails: { to: string; subject: string; text: string }[] = [];
  return {
    data,
    mails,
    log: async () => undefined,
    email: { send: async (m: { to: string; subject: string; text: string }) => void mails.push(m) },
    settings: { get: async (k: string) => settings[k] ?? null },
    storage: {
      get: async (c: string, k: string) => col(c).get(k) ?? null,
      set: async (c: string, k: string, v: unknown) => void col(c).set(k, v),
      delete: async (c: string, k: string) => void col(c).delete(k),
      list: async (
        c: string,
        o: { limit?: number; order?: "asc" | "desc" } = {},
      ): Promise<Row[]> => {
        const rows = [...col(c)].map(([key, value]) => ({
          key,
          value: value as Record<string, unknown>,
        }));
        rows.sort((a, b) => a.key.localeCompare(b.key));
        if (o.order === "desc") rows.reverse();
        return rows.slice(0, o.limit ?? 50);
      },
    },
  };
}
type Ctx = ReturnType<typeof memory>;
type Reply = {
  status: number;
  page?: { title: string; text: string };
  text?: string;
  textType?: string;
};

const SETTINGS = {
  name: "Weber Salon",
  email: "owner@example.com",
  time_zone: "Europe/Berlin",
  hours_mon: "09:00-12:00",
  hours_tue: "09:00-17:00",
  services: "Haircut | 30 | 25 EUR; Colour | 90 | from 60 EUR",
  special_days: "2026-12-01 closed Inventory",
};
// Monday 23 November 2026, 07:50 in Berlin (so with two hours of notice, 10:00 is the first free time even 10 seconds later).
const NOW = Date.UTC(2026, 10, 23, 6, 50, 0);
let ctx: Ctx;

const routes = () =>
  plugin.routes as unknown as Record<string, (r: unknown, c: Ctx) => Promise<Reply>>;
const jobs = () => plugin.jobs as unknown as Record<string, (i: unknown, c: Ctx) => Promise<void>>;
const book = (fields: Record<string, string>, t?: string) =>
  routes()["book"]!(
    { method: "POST", body: new URLSearchParams({ _t: t ?? "", ...fields }).toString() },
    ctx,
  );
const stored = () =>
  [...(ctx.data.get("bookings") ?? new Map())].map(([key, v]) => ({
    key,
    ...(v as Record<string, unknown>),
  }));

/** The form the block draws: its token and the list of times. */
async function form(props: Record<string, unknown> = {}) {
  const node = (await (
    plugin.blocks as unknown as Record<string, { render: (p: unknown, c: Ctx) => Promise<unknown> }>
  )["booking"]!.render(props, ctx)) as {
    children: { type: string; props: Record<string, unknown> }[];
  } | null;
  if (!node) return null;
  const f = node.children.find((c) => c.type === "form")?.props as
    | {
        token: string;
        fields: { name: string; options: string[]; value: string }[];
        submit: string;
      }
    | undefined;
  return { node, form: f };
}
/** Sends a request the way a browser would, a few seconds after the form was drawn. */
async function ask(fields: Record<string, string>, props: Record<string, unknown> = {}) {
  const drawn = await form(props);
  const token = drawn!.form!.token;
  vi.setSystemTime(NOW + 10_000);
  const res = await book(
    { service: "Haircut", name: "Mia", email: "mia@example.com", ...fields },
    token,
  );
  vi.setSystemTime(NOW);
  return res;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  ctx = memory(SETTINGS);
});
afterEach(() => vi.useRealTimers());

describe("times and zones", () => {
  test("a local time becomes the right moment, and a time that does not exist is refused", () => {
    expect(zonedToMs("2026-11-23", 10 * 60, "Europe/Berlin")).toBe(Date.UTC(2026, 10, 23, 9, 0));
    expect(zonedToMs("2026-07-23", 10 * 60, "Europe/Berlin")).toBe(Date.UTC(2026, 6, 23, 8, 0));
    expect(zonedToMs("2026-11-23", 10 * 60, "America/New_York")).toBe(
      Date.UTC(2026, 10, 23, 15, 0),
    );
    // 29 March 2026: the clocks in Berlin jump from 02:00 to 03:00.
    expect(zonedToMs("2026-03-29", 2 * 60 + 30, "Europe/Berlin")).toBeNull();
    expect(partsIn(Date.UTC(2026, 10, 23, 23, 30), "Europe/Berlin").date).toBe("2026-11-24");
  });

  test("the services are read from their line, with limits", () => {
    expect(parseServices("Haircut | 30 | 25 EUR; Colour | 90 | from 60 EUR")).toEqual([
      { name: "Haircut", minutes: 30, price: "25 EUR" },
      { name: "Colour", minutes: 90, price: "from 60 EUR" },
    ]);
    expect(
      parseServices(
        "A | 4 | x; B | 481 | x; C | 30; Haircut | 30 | a; haircut | 40 | b; | 30 | x; D | abc | x",
      ),
    ).toEqual([
      { name: "C", minutes: 30, price: "" },
      { name: "Haircut", minutes: 30, price: "a" },
    ]);
  });
});

describe("the free times (BZ-04)", () => {
  const b = {
    tz: "Europe/Berlin",
    week: [
      { day: 0, times: [["09:00", "12:00"]] },
      { day: 1, times: [["09:00", "17:00"]] },
    ],
    special: [{ date: "2026-12-01", note: "Inventory", times: [] }],
  };
  const options = { step: 30, noticeHours: 2, days: 14 };
  const haircut = { name: "Haircut", minutes: 30, price: "" };
  const colour = { name: "Colour", minutes: 90, price: "" };
  const list = (slots: { date: string; time: string }[]) => slots.map((s) => `${s.date} ${s.time}`);

  test("only times inside the opening hours, after the notice, that fit the whole service", () => {
    const monday = freeSlots(b, haircut, [], NOW, options).filter((s) => s.date === "2026-11-23");
    // 07:50 now and two hours notice: from 10:00; the last half hour before 12:00 starts at 11:30.
    expect(list(monday)).toEqual([
      "2026-11-23 10:00",
      "2026-11-23 10:30",
      "2026-11-23 11:00",
      "2026-11-23 11:30",
    ]);
    const long = freeSlots(b, colour, [], NOW, options).filter((s) => s.date === "2026-11-23");
    expect(list(long)).toEqual(["2026-11-23 10:00", "2026-11-23 10:30"]);
    // Tuesday is the whole day; nothing on a day that is closed (Wednesday) or on the special closed day.
    const all = list(freeSlots(b, haircut, [], NOW, { ...options, days: 14 }));
    expect(all).toContain("2026-11-24 09:00");
    expect(all).toContain("2026-11-24 16:30");
    expect(all).not.toContain("2026-11-24 17:00");
    expect(all.some((x) => x.startsWith("2026-11-25"))).toBe(false);
    expect(all.some((x) => x.startsWith("2026-12-01"))).toBe(false);
    expect(all).toContain("2026-12-07 09:00");
  });

  test("a time is a real moment in the business's zone, and only days ahead within the limit are offered", () => {
    const first = freeSlots(b, haircut, [], NOW, options)[0]!;
    expect(first.start).toBe(Date.UTC(2026, 10, 23, 9, 0));
    expect(first.end - first.start).toBe(30 * 60_000);
    const near = freeSlots(b, haircut, [], NOW, { ...options, days: 1 });
    expect(Math.max(...near.map((s) => Date.parse(`${s.date}T00:00:00Z`)))).toBe(
      Date.parse("2026-11-24T00:00:00Z"),
    );
    expect(freeSlots({ ...b, tz: "" }, haircut, [], NOW, options)).toEqual([]);
  });

  test("a booking that waits or is confirmed takes its time; a declined one does not", () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 10, 23, h - 1, m);
    const taken = { status: "pending", start: at(10, 30), end: at(11, 30) };
    expect(
      list(freeSlots(b, haircut, [taken], NOW, options)).filter((x) => x.startsWith("2026-11-23")),
    ).toEqual(["2026-11-23 10:00", "2026-11-23 11:30"]);
    expect(
      list(freeSlots(b, haircut, [{ ...taken, status: "declined" }], NOW, options)).slice(0, 4),
    ).toEqual(["2026-11-23 10:00", "2026-11-23 10:30", "2026-11-23 11:00", "2026-11-23 11:30"]);
  });
});

describe("the booking block", () => {
  const html = (node: unknown) =>
    writeBlocks(checkBlocks({ version: 1, blocks: [node] } as never).body.blocks).html;

  test("draws the service and a form that offers only free times, and the owner's choice of service", async () => {
    const drawn = (await form())!;
    const html1 = html(drawn.node);
    expect(html1).toContain("Haircut, 30 minutes, 25 EUR");
    expect(html1).toContain('action="/api/oks/plugins/business/book"');
    const slot = drawn.form!.fields.find((f) => f.name === "slot")!;
    expect(slot.options[0]).toBe("2026-11-23 10:00 (Monday)");
    expect(slot.options.length).toBeLessThanOrEqual(60);
    expect(drawn.form!.fields.find((f) => f.name === "service")!.value).toBe("Haircut");
    const colour = (await form({ service: "colour" }))!;
    expect(colour.form!.fields.find((f) => f.name === "service")!.value).toBe("Colour");
    expect(colour.form!.fields.find((f) => f.name === "slot")!.options).not.toContain(
      "2026-11-23 11:00 (Monday)",
    );
  });

  test("draws nothing without services or hours, and says so when nothing is free", async () => {
    ctx = memory({ ...SETTINGS, services: "" });
    expect(await form()).toBeNull();
    ctx = memory({ ...SETTINGS, time_zone: "" });
    expect(await form()).toBeNull();
    ctx = memory({ ...SETTINGS, hours_mon: "", hours_tue: "" });
    const none = (await form())!;
    expect(none.form).toBeUndefined();
    expect(html(none.node)).toContain("There are no free times at the moment.");
  });
});

describe("asking for a time", () => {
  test("a free time becomes a request that waits; the owner and the visitor are told", async () => {
    const r = await ask({
      slot: "2026-11-23 10:30 (Monday)",
      phone: "+49 30 123456",
      note: "By the window",
    });
    expect(r).toMatchObject({ status: 200, page: { title: "Thank you" } });
    expect(r.page?.text).toContain("We will confirm it by email");
    expect(stored()).toEqual([
      expect.objectContaining({
        status: "pending",
        service: "Haircut",
        start: Date.UTC(2026, 10, 23, 9, 30),
        startText: "2026-11-23 10:30 (Monday)",
        emails: ["mia@example.com"],
        notified: "",
      }),
    ]);
    expect(ctx.mails.map((m) => m.to).sort()).toEqual(["mia@example.com", "owner@example.com"]);
    expect(ctx.mails.find((m) => m.to === "owner@example.com")!.text).toContain("By the window");
    // The time is taken now: it is not offered again, and asking for it is refused with the free times.
    const again = await ask({ slot: "2026-11-23 10:30 (Monday)", email: "bo@example.com" });
    expect(again.status).toBe(409);
    expect(again.page?.text).toContain("Free times:");
    expect(again.page?.text).toContain("2026-11-23 10:00");
    expect(stored().length).toBe(1);
    expect((await form())!.form!.fields.find((f) => f.name === "slot")!.options).not.toContain(
      "2026-11-23 10:30 (Monday)",
    );
  });

  test.each([
    ["a time outside the opening hours", { slot: "2026-11-23 15:00 (Monday)" }],
    ["a time that is too soon", { slot: "2026-11-23 09:00 (Monday)" }],
    ["a day that is closed", { slot: "2026-11-25 10:00 (Wednesday)" }],
    ["a service that is not offered", { service: "Massage", slot: "2026-11-23 10:00 (Monday)" }],
    ["no time", { slot: "" }],
    ["a bad email", { slot: "2026-11-23 10:00 (Monday)", email: "mia" }],
    ["no name", { slot: "2026-11-23 10:00 (Monday)", name: " " }],
    ["a bad phone number", { slot: "2026-11-23 10:00 (Monday)", phone: "abc" }],
  ])("%s is refused and nothing is kept", async (_name, fields) => {
    const r = await ask(fields);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(stored()).toEqual([]);
    expect(ctx.mails).toEqual([]);
  });

  test("a service too long for the time is refused: a long service does not fit before closing", async () => {
    const r = await ask({ service: "Colour", slot: "2026-11-23 11:00 (Monday)" });
    expect(r.status).toBe(409);
    expect(stored()).toEqual([]);
  });

  test("spam gets the same thanks and nothing is kept; instant booking confirms at once", async () => {
    const drawn = await form();
    const early = await book(
      {
        service: "Haircut",
        name: "Bo",
        email: "bo@example.com",
        slot: "2026-11-23 10:00 (Monday)",
      },
      drawn!.form!.token,
    );
    expect(early).toMatchObject({ status: 200, page: { title: "Thank you" } });
    expect((await ask({ slot: "2026-11-23 10:00 (Monday)", _hp: "x" })).page?.title).toBe(
      "Thank you",
    );
    expect(
      (await ask({ slot: "2026-11-23 10:00 (Monday)", note: "see https://spam.example" })).page
        ?.title,
    ).toBe("Thank you");
    expect(stored()).toEqual([]);
    ctx = memory({ ...SETTINGS, booking_instant: true });
    const sure = await ask({ slot: "2026-11-23 10:00 (Monday)" });
    expect(sure).toMatchObject({ status: 200, page: { title: "Booked" } });
    expect(stored()[0]).toMatchObject({ status: "confirmed", notified: "confirmed" });
    expect(ctx.mails.some((m) => m.subject.startsWith("Your booking is confirmed"))).toBe(true);
  });
});

describe("the owner's decision, the calendar and the clean-up", () => {
  test("BZ-04: when the owner confirms or declines, the visitor is emailed once", async () => {
    await ask({ slot: "2026-11-23 10:00 (Monday)" });
    await ask({ slot: "2026-11-23 11:00 (Monday)", name: "Bo", email: "bo@example.com" });
    ctx.mails.length = 0;
    await jobs()["notify"]!({}, ctx);
    expect(ctx.mails).toEqual([]);
    const [a, b] = stored();
    await ctx.storage.set("bookings", a!.key, { ...a, key: undefined, status: "confirmed" });
    await ctx.storage.set("bookings", b!.key, { ...b, key: undefined, status: "declined" });
    await jobs()["notify"]!({}, ctx);
    const to = (who: string) => ctx.mails.filter((m) => m.to === who);
    expect(to("mia@example.com")).toHaveLength(1);
    expect(to("mia@example.com")[0]!.subject).toContain("confirmed");
    expect(to("bo@example.com")).toHaveLength(1);
    expect(to("bo@example.com")[0]!.text).toContain("cannot take your booking request");
    await jobs()["notify"]!({}, ctx);
    expect(ctx.mails).toHaveLength(2);
    // A declined time is free again.
    expect((await form())!.form!.fields.find((f) => f.name === "slot")!.options).toContain(
      "2026-11-23 11:00 (Monday)",
    );
  });

  test("BZ-05: the private calendar shows confirmed bookings only, and only with its secret address", async () => {
    await ask({ slot: "2026-11-23 10:00 (Monday)", phone: "+49 30 123456" });
    await ask({ slot: "2026-11-23 11:00 (Monday)", name: "Bo", email: "bo@example.com" });
    const [a] = stored();
    await ctx.storage.set("bookings", a!.key, { ...a, key: undefined, status: "confirmed" });
    const secret = String(
      ((await ctx.storage.get("feed", "address")) as { path: string }).path.split("key=")[1],
    );
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    const get = (key?: string) =>
      routes()["calendar"]!(
        { method: "GET", query: key === undefined ? {} : { key }, body: "" },
        ctx,
      );
    for (const wrong of [undefined, "", "x", secret.slice(1), secret + "0", secret.toUpperCase()])
      expect((await get(wrong)).status).toBe(404);
    const ok = await get(secret);
    expect(ok).toMatchObject({ status: 200, textType: "calendar" });
    const text = ok.text!;
    expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(text).toContain("DTSTART:20261123T090000Z");
    expect(text).toContain("DTEND:20261123T093000Z");
    expect(text).toContain("SUMMARY:Haircut - Mia");
    expect(text).toContain("+49 30 123456");
    expect(text).not.toContain("bo@example.com");
    expect(text).not.toContain("Haircut - Bo");
  });

  test("bookings are deleted a year after their day, and not before", async () => {
    await ctx.storage.set("bookings", "old", {
      status: "confirmed",
      start: NOW - 400 * 86_400_000,
      end: NOW - 400 * 86_400_000 + 1800_000,
      service: "x",
      name: "x",
    });
    await ctx.storage.set("bookings", "recent", {
      status: "confirmed",
      start: NOW - 300 * 86_400_000,
      end: NOW - 300 * 86_400_000 + 1800_000,
      service: "x",
      name: "x",
    });
    await jobs()["tidy"]!({}, ctx);
    expect([...(ctx.data.get("bookings") ?? new Map()).keys()]).toEqual(["recent"]);
  });
});
