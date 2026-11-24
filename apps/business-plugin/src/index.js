// The Business plugin (spec 19). It keeps the details of a business and its opening hours in its settings, and draws three
// blocks from them: the opening hours (the core's own block, which says "open now" in the visitor's browser), the contact
// details, and a payment link. The structured data for search engines is written by the site from the same settings. The
// plugin never sees a visitor, takes no card details and sends nothing anywhere.

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIME = /^(?:[01]?\d|2[0-3]):[0-5]\d$|^24:00$/;
const SPAN = /^\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*$/;

const clean = (value, max) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** `9:00` as `09:00`. */
const pad = (t) => (t.length === 4 ? `0${t}` : t);
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The opening times written in a day's setting ("09:00-12:00, 13:00-17:00"), or an empty list for a closed day. */
export function parseTimes(text) {
  const spans = [];
  for (const part of clean(text, 200).split(",")) {
    const m = SPAN.exec(part);
    if (!m) continue;
    const from = pad(m[1]);
    const to = pad(m[2]);
    if (!TIME.test(from) || !TIME.test(to) || from === "24:00" || minutes(to) <= minutes(from))
      continue;
    spans.push([from, to]);
  }
  return spans;
}

/** The special days written in the setting ("2026-12-25 closed Christmas Day; 2026-12-24 09:00-12:00 Christmas Eve"). */
export function parseSpecialDays(text) {
  const out = [];
  for (const item of clean(text, 1500).split(";")) {
    const m =
      /^\s*(\d{4}-\d{2}-\d{2})\s+(closed|(?:\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}\s*,?\s*)+)\s*(.*)$/i.exec(
        item,
      );
    if (!m) continue;
    // A real calendar day only (not 30 February).
    if (new Date(`${m[1]}T00:00:00Z`).toISOString().slice(0, 10) !== m[1]) continue;
    out.push({
      date: m[1],
      note: clean(m[3], 80),
      times: m[2].toLowerCase() === "closed" ? [] : parseTimes(m[2]),
    });
  }
  return out;
}

/** Everything the blocks need, read from the plugin's settings. */
async function read(ctx) {
  const get = async (key) => clean(await ctx.settings.get(key), 1500);
  const week = [];
  for (const [day, key] of DAYS.entries()) {
    const times = parseTimes(await get(`hours_${key}`));
    if (times.length > 0) week.push({ day, times });
  }
  return {
    name: await get("name"),
    street: await get("street"),
    postal: await get("postal"),
    city: await get("city"),
    country: (await get("country")).toUpperCase(),
    phone: await get("phone"),
    email: await get("email"),
    tz: await get("time_zone"),
    week,
    special: parseSpecialDays(await get("special_days")),
  };
}

const text = (t, styles) => ({ type: "text", text: t, ...(styles ? { styles } : {}) });
const paragraph = (id, content) => ({
  id,
  type: "paragraph",
  props: {},
  content,
  children: [],
});

export default {
  blocks: {
    "opening-hours": {
      async render(props, ctx) {
        const b = await read(ctx);
        if (!b.tz || (b.week.length === 0 && b.special.length === 0)) return null;
        return {
          id: "oh",
          type: "openingHours",
          props: { title: clean(props?.title, 80), tz: b.tz, week: b.week, special: b.special },
          content: null,
          children: [],
        };
      },
    },
    "contact-details": {
      async render(props, ctx) {
        const b = await read(ctx);
        const children = [];
        const title = clean(props?.title, 80);
        if (title)
          children.push({
            id: "cd-title",
            type: "heading",
            props: { level: 2 },
            content: [text(title)],
            children: [],
          });
        if (b.name) children.push(paragraph("cd-name", [text(b.name, { bold: true })]));
        const street = b.street;
        const town = [b.postal, b.city].filter(Boolean).join(" ");
        const lines = [street, town, b.country].filter(Boolean);
        if (lines.length > 0) children.push(paragraph("cd-address", [text(lines.join(", "))]));
        if (b.phone) {
          const digits = b.phone.replace(/[^\d+]/g, "");
          children.push(
            paragraph("cd-phone", [
              text("Phone: "),
              digits.length >= 5
                ? { type: "link", text: b.phone, href: `tel:${digits}` }
                : text(b.phone),
            ]),
          );
        }
        if (b.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))
          children.push(
            paragraph("cd-email", [
              text("Email: "),
              { type: "link", text: b.email, href: `mailto:${b.email}` },
            ]),
          );
        if (children.length === 0) return null;
        return { id: "cd", type: "container", props: {}, content: null, children };
      },
    },
    "payment-link": {
      async render(props) {
        // The address must be https and is the owner's own payment page; the site holds no card details and no order data.
        const url = clean(props?.url, 500);
        if (!/^https:\/\/[^\s"<>]+$/.test(url)) return null;
        const label = clean(props?.label, 40) || "Pay now";
        const note = clean(props?.note, 200);
        const button = {
          id: "pl-button",
          type: "button",
          props: { text: label, href: url, variant: "solid" },
          content: null,
          children: [],
        };
        if (!note) return button;
        return {
          id: "pl",
          type: "container",
          props: {},
          content: null,
          children: [button, paragraph("pl-note", [text(note)])],
        };
      },
    },
  },
};
