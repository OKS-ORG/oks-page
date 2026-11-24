// The Business plugin (spec 19). It keeps the details of a business and its opening hours in its settings, and draws three
// blocks from them: the opening hours (the core's own block, which says "open now" in the visitor's browser), the contact
// details, and a payment link. The structured data for search engines is written by the site from the same settings. The
// plugin never sees a visitor, takes no card details and sends nothing anywhere.

/* global crypto, TextEncoder, URLSearchParams */

const DAY = 24 * 60 * 60 * 1000;
const MIN_SECONDS = 3;
const MOST_REVIEWS_PER_HOUR = 20;
const BAD_WORDS = ["viagra", "cialis", "casino", "porn"];
const EMAIL = /^[^\s@,;<>]{1,64}@[^\s@,;<>]{1,190}\.[^\s@,;<>]{2,}$/;

const hex = (bytes) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

async function secretOf(ctx) {
  let secret = await ctx.storage.get("secrets", "hmac");
  if (typeof secret !== "string" || secret.length < 32) {
    secret = hex(crypto.getRandomValues(new Uint8Array(32)));
    await ctx.storage.set("secrets", "hmac", secret);
  }
  return secret;
}

/** The time the form was drawn, signed, so a program cannot send a review faster than a person. */
async function makeToken(ctx) {
  const at = Date.now();
  return `${at}.${(await hmac(await secretOf(ctx), `reviews.${at}`)).slice(0, 32)}`;
}

/** "ok", "fast", "old" or "invalid". */
async function readToken(ctx, token) {
  const m = /^(\d{10,15})\.([0-9a-f]{32})$/.exec(token);
  if (!m) return "invalid";
  if ((await hmac(await secretOf(ctx), `reviews.${m[1]}`)).slice(0, 32) !== m[2]) return "invalid";
  const age = Date.now() - Number(m[1]);
  if (age < MIN_SECONDS * 1000) return "fast";
  return age > 30 * DAY ? "old" : "ok";
}

const problem = (status, title, text) => ({ status, page: { title, text } });

/** The reviews that were approved, newest first (the latest 500 are read). */
async function approvedReviews(ctx) {
  const rows = await ctx.storage.list("reviews", { limit: 500, order: "desc" });
  return rows
    .map((r) => r.value)
    .filter(
      (v) =>
        v && v.status === "approved" && Number.isInteger(v.stars) && v.stars >= 1 && v.stars <= 5,
    );
}

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
  routes: {
    // A visitor sends a review. It is kept apart until the owner has read it (spec 19, section 6): nothing is shown, and no
    // rating counts, before it is approved.
    async review(req, ctx) {
      const params = new URLSearchParams(req.body);
      const timing = await readToken(ctx, params.get("_t") ?? "");
      const stars = Number(params.get("stars") ?? "");
      const name = clean(params.get("name"), 60);
      const text = clean(params.get("text"), 1000);
      const email = clean(params.get("email"), 200).toLowerCase();
      const errors = [];
      if (!Number.isInteger(stars) || stars < 1 || stars > 5)
        errors.push("Your rating: choose from 1 to 5 stars.");
      if (name === "") errors.push("Your name: this is required.");
      if (text.length < 10) errors.push("Your review: please write at least a few words.");
      if (email !== "" && !EMAIL.test(email))
        errors.push("Your email: this is not an email address.");
      const lower = `${name} ${text}`.toLowerCase();
      const spam =
        (params.get("_hp") ?? "") !== "" ||
        timing === "invalid" ||
        timing === "fast" ||
        (lower.match(/https?:\/\/|www\./g) ?? []).length > 0 ||
        BAD_WORDS.some((w) => lower.includes(w));
      if (!spam && timing === "old")
        return problem(
          400,
          "This page is out of date",
          "Go back, reload the page and send your review again.",
        );
      if (!spam && errors.length > 0)
        return problem(400, "Please check your answers", errors.join("\n\n"));
      // A program is told the same as a person: it learns nothing about why a review was kept apart.
      const thanks = problem(
        200,
        "Thank you",
        "Thank you. Your review will be shown after the owner has read it.",
      );
      const hour = Math.floor(Date.now() / 3_600_000);
      const row = await ctx.storage.get("rate", "reviews");
      const n = row && row.hour === hour ? row.n : 0;
      await ctx.storage.set("rate", "reviews", { hour, n: n + 1 });
      if (n >= MOST_REVIEWS_PER_HOUR) return thanks;
      if (spam && !(stars >= 1 && stars <= 5 && name && text)) return thanks;
      const at = Date.now();
      const key = `${String(at).padStart(15, "0")}-${hex(crypto.getRandomValues(new Uint8Array(3)))}`;
      await ctx.storage.set("reviews", key, {
        status: spam ? "spam" : "pending",
        at,
        stars: Math.min(Math.max(Math.trunc(stars) || 1, 1), 5),
        name,
        text,
        // The address is kept only so that the owner can find and delete a person's review (spec 18, section 5); it is never shown.
        emails: email !== "" && EMAIL.test(email) ? [email] : [],
      });
      return thanks;
    },
  },
  blocks: {
    reviews: {
      async render(props, ctx) {
        const reviews = await approvedReviews(ctx);
        const most = Math.min(Math.max(Math.trunc(Number(props?.most)) || 5, 1), 20);
        const children = [
          {
            id: "rv-title",
            type: "heading",
            props: { level: 2 },
            content: [text(clean(props?.title, 80) || "Reviews")],
            children: [],
          },
        ];
        if (reviews.length > 0) {
          const average = reviews.reduce((n, r) => n + r.stars, 0) / reviews.length;
          children.push(
            paragraph("rv-average", [
              text(
                `${average.toFixed(1)} out of 5, from ${reviews.length} review${reviews.length === 1 ? "" : "s"}`,
                { bold: true },
              ),
            ]),
          );
          for (const [i, r] of reviews.slice(0, most).entries()) {
            children.push({
              id: `rv-q${i}`,
              type: "quote",
              props: {},
              content: [text(clean(r.text, 1000))],
              children: [],
            });
            children.push(
              paragraph(`rv-by${i}`, [
                text(
                  `${r.stars} out of 5 stars, ${clean(r.name, 60)}, ${new Date(r.at).toISOString().slice(0, 10)}`,
                ),
              ]),
            );
          }
        } else children.push(paragraph("rv-none", [text("There are no reviews yet.")]));
        if (props?.show_form !== false)
          children.push({
            id: "rv-form",
            type: "form",
            props: {
              action: "/api/oks/plugins/business/review",
              title: "Write a review",
              submit: "Send review",
              note: "Your review is shown after the owner has read it.",
              noteHref: "",
              token: await makeToken(ctx),
              formId: "reviews",
              fields: [
                {
                  name: "stars",
                  label: "Your rating (5 is best)",
                  type: "select",
                  required: true,
                  help: "",
                  placeholder: "",
                  options: ["5", "4", "3", "2", "1"],
                  value: "",
                },
                {
                  name: "name",
                  label: "Your name",
                  type: "text",
                  required: true,
                  help: "",
                  placeholder: "",
                  options: [],
                  value: "",
                },
                {
                  name: "text",
                  label: "Your review",
                  type: "textarea",
                  required: true,
                  help: "",
                  placeholder: "",
                  options: [],
                  value: "",
                },
                {
                  name: "email",
                  label: "Your email (optional, never shown)",
                  type: "email",
                  required: false,
                  help: "Only so that you can ask us to delete your review later.",
                  placeholder: "",
                  options: [],
                  value: "",
                },
              ],
            },
            content: null,
            children: [],
          });
        return { id: "rv", type: "container", props: {}, content: null, children };
      },
    },
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
