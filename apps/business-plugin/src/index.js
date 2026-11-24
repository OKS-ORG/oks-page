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

// ---- booking (spec 19, section 7) -----------------------------------------------------------------------------------

const MINUTE = 60_000;

/** The parts of a moment in a time zone: `y`, `m` (1 to 12), `d`, minutes after midnight, and the date as text. */
export function partsIn(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const date = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { y, m, d, minutes: get("hour") * 60 + get("minute"), date };
}

/** The moment (in milliseconds) of a local date and minutes after midnight in a time zone, or null when that time does not exist there. */
export function zonedToMs(date, minutes, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const offset = (t) => {
    const p = partsIn(t, tz);
    return Date.UTC(p.y, p.m - 1, p.d, 0, p.minutes) - Math.floor(t / MINUTE) * MINUTE;
  };
  const ms = guess - offset(guess - offset(guess));
  const back = partsIn(ms, tz);
  return back.date === date && back.minutes === minutes ? ms : null;
}

const addDays = (date, n) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
const clockOf = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The services written in the setting ("Haircut | 30 | 25 EUR; Colour | 90 | from 60 EUR"). */
export function parseServices(text) {
  const out = [];
  for (const item of clean(text, 2000).split(";")) {
    const [name, length, price] = item.split("|").map((x) => x.trim());
    const minutes = Number(length);
    if (!name || !Number.isInteger(minutes) || minutes < 5 || minutes > 480) continue;
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ name: name.slice(0, 60), minutes, price: clean(price ?? "", 40) });
    if (out.length >= 20) break;
  }
  return out;
}

/** The times when the business is open on one date: its special day if it has one, else the week's times. */
function openOn(b, date) {
  const special = b.special.find((x) => x.date === date);
  if (special) return special.times;
  return b.week.find((w) => w.day === weekdayOf(date))?.times ?? [];
}

/**
 * The times a service can be booked, in time order: inside the opening hours, on the step of the day, not too soon, not too far
 * ahead, and not on top of a booking that is waiting or confirmed (BZ-04).
 */
export function freeSlots(b, service, booked, now, options) {
  const out = [];
  if (!b.tz) return out;
  const today = partsIn(now, b.tz).date;
  const busy = booked
    .filter((x) => (x.status === "pending" || x.status === "confirmed") && x.end > now)
    .map((x) => [x.start, x.end]);
  for (let ahead = 0; ahead <= options.days; ahead += 1) {
    const date = addDays(today, ahead);
    for (const [from, to] of openOn(b, date)) {
      const open = Number(from.slice(0, 2)) * 60 + Number(from.slice(3, 5));
      const close = Number(to.slice(0, 2)) * 60 + Number(to.slice(3, 5));
      for (
        let at = Math.ceil(open / options.step) * options.step;
        at + service.minutes <= close;
        at += options.step
      ) {
        const start = zonedToMs(date, at, b.tz);
        if (start === null || start < now + options.noticeHours * 3_600_000) continue;
        const end = start + service.minutes * MINUTE;
        if (busy.some(([s, e]) => start < e && end > s)) continue;
        out.push({ date, time: clockOf(at), start, end });
      }
    }
  }
  return out;
}

const slotText = (slot) => `${slot.date} ${slot.time} (${WEEKDAYS[weekdayOf(slot.date)]})`;

/** What the booking needs from the settings. */
async function readBooking(ctx) {
  const get = async (key) => clean(await ctx.settings.get(key), 2000);
  const number = async (key, fallback, least, most) => {
    // A setting that was never filled in is the default, not zero.
    const raw = await ctx.settings.get(key);
    if (raw === null || raw === undefined || raw === "") return fallback;
    const v = Math.trunc(Number(raw));
    return Number.isFinite(v) && v >= least && v <= most ? v : fallback;
  };
  return {
    services: parseServices(await get("services")),
    step: await number("booking_step", 30, 5, 120),
    noticeHours: await number("booking_notice_hours", 2, 0, 168),
    days: await number("booking_days", 14, 1, 60),
    instant: (await ctx.settings.get("booking_instant")) === true,
    notify: clean((await get("booking_email")) || (await get("email")), 200),
  };
}

/** The bookings (the latest 500) with their time as numbers. */
async function bookings(ctx) {
  const rows = await ctx.storage.list("bookings", { limit: 500, order: "desc" });
  return rows
    .filter((r) => r.value && Number.isFinite(r.value.start) && Number.isFinite(r.value.end))
    .map((r) => ({ ...r.value, key: r.key }));
}

const icsEscape = (v) =>
  String(v)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
const icsTime = (ms) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** The calendar of the confirmed bookings, as a calendar file. */
function calendar(name, list) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Business//Bookings//EN",
    `X-WR-CALNAME:${icsEscape(name || "Bookings")}`,
  ];
  for (const x of list) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${x.key}@bookings.invalid`,
      `DTSTAMP:${icsTime(x.at ?? x.start)}`,
      `DTSTART:${icsTime(x.start)}`,
      `DTEND:${icsTime(x.end)}`,
      `SUMMARY:${icsEscape(`${x.service} - ${x.name}`)}`,
      `DESCRIPTION:${icsEscape([x.phone && `Phone: ${x.phone}`, x.email && `Email: ${x.email}`, x.note].filter(Boolean).join("\n"))}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

const stripKey = (x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "key"));

/** Keeps the private calendar's secret and writes its address where the owner can read it (Tools > Plugins > Calendar). */
async function feedAddress(ctx) {
  let secret = await ctx.storage.get("secrets", "calendar");
  if (typeof secret !== "string" || secret.length < 32) {
    secret = hex(crypto.getRandomValues(new Uint8Array(24)));
    await ctx.storage.set("secrets", "calendar", secret);
  }
  await ctx.storage.set("feed", "address", {
    title: "Calendar of confirmed bookings",
    path: `/api/oks/plugins/business/calendar?key=${secret}`,
    at: Date.now(),
  });
}

async function trySend(ctx, to, subject, text) {
  try {
    await ctx.email.send({ to, subject, text });
  } catch (error) {
    await ctx.log(
      `email to ${to.replace(/^.*@/, "...@")} was not sent: ${String(error && error.message).slice(0, 100)}`,
    );
  }
}

export default {
  jobs: {
    // Every few minutes: tell a visitor whose booking was confirmed or declined (the owner decides in the admin), and keep the
    // address of the private calendar where the owner can find it.
    async notify(_info, ctx) {
      const b = await read(ctx);
      const list = await bookings(ctx);
      for (const x of list) {
        if (
          (x.status !== "confirmed" && x.status !== "declined") ||
          x.notified === x.status ||
          !x.email
        )
          continue;
        const when = `${x.startText}`;
        const subject =
          x.status === "confirmed"
            ? `Your booking is confirmed: ${when}`
            : `About your booking request: ${when}`;
        const text =
          x.status === "confirmed"
            ? `Hello ${x.name},\n\nyour booking is confirmed.\n\n${x.service}\n${when}\n\n${b.name || ""}`.trim()
            : `Hello ${x.name},\n\nsorry, we cannot take your booking request for ${x.service} on ${when}. Please choose another time on our website, or write to us.\n\n${b.name || ""}`.trim();
        await trySend(ctx, x.email, subject.slice(0, 150), text);
        await ctx.storage.set("bookings", x.key, { ...stripKey(x), notified: x.status });
      }
      await feedAddress(ctx);
    },
    // Once a day: bookings older than a year (counted from the booked day) are deleted (spec 19, section 7).
    async tidy(_info, ctx) {
      const cutoff = Date.now() - 365 * DAY;
      for (const x of await bookings(ctx))
        if (x.end < cutoff) await ctx.storage.delete("bookings", x.key);
    },
  },
  routes: {
    // A visitor asks for a time (spec 19, section 7). The time must be free and inside the opening hours, checked again here;
    // the request waits for the owner unless instant booking is on.
    async book(req, ctx) {
      const params = new URLSearchParams(req.body);
      const b = { ...(await read(ctx)), ...(await readBooking(ctx)) };
      const timing = await readToken(ctx, params.get("_t") ?? "");
      const service = b.services.find((x) => x.name === params.get("service"));
      const slotMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(params.get("slot") ?? "");
      const name = clean(params.get("name"), 80);
      const email = clean(params.get("email"), 200).toLowerCase();
      const phone = clean(params.get("phone"), 40);
      const note = clean(params.get("note"), 300);
      const lower = `${name} ${note}`.toLowerCase();
      const spam =
        (params.get("_hp") ?? "") !== "" ||
        timing === "invalid" ||
        timing === "fast" ||
        (lower.match(/https?:\/\/|www\./g) ?? []).length > 0 ||
        BAD_WORDS.some((w) => lower.includes(w));
      const thanks = problem(200, "Thank you", "Thank you. We got your request.");
      if (spam) return thanks;
      if (timing === "old")
        return problem(
          400,
          "This page is out of date",
          "Go back, reload the page and send your request again.",
        );
      const errors = [];
      if (!service) errors.push("The service: choose one from the list.");
      if (!slotMatch) errors.push("The time: choose one from the list.");
      if (name === "") errors.push("Your name: this is required.");
      if (!EMAIL.test(email)) errors.push("Your email: write an address we can answer.");
      if (phone !== "" && !/^[0-9+().\-\s]{5,30}$/.test(phone))
        errors.push("Your phone number: this is not a phone number.");
      if (errors.length > 0) return problem(400, "Please check your answers", errors.join("\n\n"));
      const hour = Math.floor(Date.now() / 3_600_000);
      const row = await ctx.storage.get("rate", "bookings");
      const n = row && row.hour === hour ? row.n : 0;
      await ctx.storage.set("rate", "bookings", { hour, n: n + 1 });
      if (n >= MOST_REVIEWS_PER_HOUR) return thanks;
      const now = Date.now();
      const free = freeSlots(b, service, await bookings(ctx), now, b);
      const chosen = free.find((x) => x.date === slotMatch[1] && x.time === slotMatch[2]);
      if (!chosen) {
        const next = free.slice(0, 5).map(slotText).join("\n");
        return problem(
          409,
          "That time is not free",
          `Sorry, that time cannot be booked (it was taken, or it is outside our opening hours).${next ? `\n\nFree times:\n${next}` : ""}\n\nGo back, reload the page and choose another time.`,
        );
      }
      const at = now;
      const key = `${String(at).padStart(15, "0")}-${hex(crypto.getRandomValues(new Uint8Array(3)))}`;
      const status = b.instant ? "confirmed" : "pending";
      await ctx.storage.set("bookings", key, {
        status,
        at,
        service: service.name,
        minutes: service.minutes,
        price: service.price,
        start: chosen.start,
        end: chosen.end,
        startText: slotText(chosen),
        name,
        email,
        phone,
        note,
        emails: [email],
        notified: status === "confirmed" ? "confirmed" : "",
      });
      await feedAddress(ctx);
      const when = slotText(chosen);
      if (status === "confirmed")
        await trySend(
          ctx,
          email,
          `Your booking is confirmed: ${when}`,
          `Hello ${name},\n\nyour booking is confirmed.\n\n${service.name}\n${when}\n\n${b.name || ""}`.trim(),
        );
      else
        await trySend(
          ctx,
          email,
          "We got your booking request",
          `Hello ${name},\n\nwe got your request for ${service.name} on ${when}. We will confirm it by email.\n\n${b.name || ""}`.trim(),
        );
      if (b.notify && EMAIL.test(b.notify))
        await trySend(
          ctx,
          b.notify,
          `New booking ${status === "confirmed" ? "" : "request: "}${when}`.slice(0, 150),
          [
            `${name} (${email}${phone ? `, ${phone}` : ""})`,
            `${service.name}, ${service.minutes} minutes`,
            when,
            note && `Note: ${note}`,
            "",
            status === "confirmed"
              ? "It was confirmed at once."
              : "Open Tools > Plugins > Bookings to confirm or decline it.",
          ]
            .filter((x) => x !== false && x !== "")
            .join("\n"),
        );
      return status === "confirmed"
        ? problem(
            200,
            "Booked",
            `Your booking is confirmed: ${service.name}, ${when}. We sent you an email.`,
          )
        : problem(
            200,
            "Thank you",
            `We got your request for ${service.name}, ${when}. We will confirm it by email.`,
          );
    },
    // The private calendar: only the confirmed bookings, and only with the secret address (spec 19, section 7).
    async calendar(req, ctx) {
      const feed = await ctx.storage.get("secrets", "calendar");
      const given = String(req.query?.key ?? "");
      if (
        typeof feed !== "string" ||
        feed.length < 32 ||
        given.length !== feed.length ||
        given !== feed
      )
        return problem(404, "Not found", "There is nothing at this address.");
      const b = await read(ctx);
      const confirmed = (await bookings(ctx)).filter((x) => x.status === "confirmed").reverse();
      return { status: 200, text: calendar(b.name, confirmed), textType: "calendar" };
    },
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
    booking: {
      async render(props, ctx) {
        const b = { ...(await read(ctx)), ...(await readBooking(ctx)) };
        const wanted = clean(props?.service, 60).toLowerCase();
        const service = b.services.find((x) => x.name.toLowerCase() === wanted) ?? b.services[0];
        if (!service || !b.tz) return null;
        const free = freeSlots(b, service, await bookings(ctx), Date.now(), b).slice(0, 60);
        const children = [
          {
            id: "bk-title",
            type: "heading",
            props: { level: 2 },
            content: [text(clean(props?.title, 80) || "Book a time")],
            children: [],
          },
          paragraph("bk-what", [
            text(
              `${service.name}, ${service.minutes} minutes${service.price ? `, ${service.price}` : ""}`,
              { bold: true },
            ),
          ]),
        ];
        if (free.length === 0)
          children.push(
            paragraph("bk-none", [
              text("There are no free times at the moment. Please contact us."),
            ]),
          );
        else
          children.push({
            id: "bk-form",
            type: "form",
            props: {
              action: "/api/oks/plugins/business/book",
              title: "",
              submit: b.instant ? "Book now" : "Send booking request",
              note: b.instant ? "" : "We will confirm your booking by email.",
              noteHref: "",
              token: await makeToken(ctx),
              formId: "bookings",
              fields: [
                {
                  name: "service",
                  label: "Service",
                  type: "hidden",
                  required: false,
                  help: "",
                  placeholder: "",
                  options: [],
                  value: service.name,
                },
                {
                  name: "slot",
                  label: "Time",
                  type: "select",
                  required: true,
                  help: "",
                  placeholder: "",
                  options: free.map(slotText),
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
                  name: "email",
                  label: "Your email",
                  type: "email",
                  required: true,
                  help: "",
                  placeholder: "",
                  options: [],
                  value: "",
                },
                {
                  name: "phone",
                  label: "Your phone number (optional)",
                  type: "tel",
                  required: false,
                  help: "",
                  placeholder: "",
                  options: [],
                  value: "",
                },
                {
                  name: "note",
                  label: "A note (optional)",
                  type: "textarea",
                  required: false,
                  help: "",
                  placeholder: "",
                  options: [],
                  value: "",
                },
              ],
            },
            content: null,
            children: [],
          });
        return { id: "bk", type: "container", props: {}, content: null, children };
      },
    },
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
