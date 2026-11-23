/* global crypto, TextEncoder, URLSearchParams */
// The Forms plugin (spec 16). One block, "form", draws a form from a short text that lists the fields; one address,
// "send", receives what a visitor sends. The plugin checks it for spam without any outside service, keeps the message in
// its own storage and emails it to the owner. It never sees who the visitor is: only what they typed.

const DEFAULT_FIELDS = "Name*; Email*:email; Message*:long";
const MOST_FIELDS = 30;
const MIN_SECONDS = 3;
const DAY = 24 * 60 * 60 * 1000;
const MOST_PER_HOUR = 30;
const DEFAULT_WORDS = ["viagra", "cialis", "casino", "porn"];
const KINDS = {
  text: "text",
  email: "email",
  phone: "tel",
  tel: "tel",
  long: "textarea",
  textarea: "textarea",
  number: "number",
  date: "date",
  choice: "radio",
  radio: "radio",
  select: "select",
  dropdown: "select",
  ticks: "checkbox",
  checkbox: "checkbox",
  consent: "consent",
  hidden: "hidden",
  file: "file",
  upload: "file",
};

const clean = (value, max) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

const hex = (bytes) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

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

/** The name a field is sent under: its label in lower-case letters, digits and underscores. */
function nameOf(label, taken, index) {
  let base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  if (!/^[a-z]/.test(base)) base = `field_${index + 1}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

/** "Name*; Email*:email; Topic:choice(Sales|Support)" becomes the list of fields. A star means required. */
export function parseFields(text) {
  const fields = [];
  const taken = new Set();
  for (const part of String(text).split(/[;\n]/)) {
    const m = /^(.*?)\s*(\*)?\s*(?::\s*([a-z]+)\s*(?:\(([^)]*)\))?)?\s*$/i.exec(part.trim());
    if (!m || fields.length >= MOST_FIELDS) continue;
    addField(fields, taken, m[1], m[3] ?? "text", m[2] === "*", m[4] ?? "");
  }
  return fields;
}

/** Adds one field when it is sound: a question (a hidden value needs none), a known kind, and choices where the kind asks. */
function addField(fields, taken, labelText, kind, required, choices) {
  if (fields.length >= MOST_FIELDS) return;
  const label = clean(labelText, 200);
  const type = KINDS[String(kind).toLowerCase()];
  if (!type || (label === "" && type !== "hidden")) return;
  const list = String(choices)
    .split("|")
    .map((o) => clean(o, 100))
    .filter((o) => o !== "");
  if ((type === "select" || type === "radio" || type === "checkbox") && list.length === 0) return;
  // One file question for a form: the site takes at most 3 files for a message.
  if (type === "file" && fields.some((f) => f.type === "file")) return;
  fields.push({
    name: nameOf(label || "hidden", taken, fields.length),
    label,
    type,
    required: required === true && type !== "hidden",
    options: type === "hidden" || type === "file" ? [] : list.slice(0, 30),
    value: type === "hidden" ? (list[0] ?? "") : "",
    ...(type === "file" ? { help: "Up to 3 pictures or PDF files, 10 MB each." } : {}),
  });
}

/** The fields the page builder's list makes: a list of { label, kind, required, options }. */
export function fieldsFromList(rows) {
  const fields = [];
  const taken = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    addField(
      fields,
      taken,
      row.label,
      row.kind || "text",
      row.required === true,
      row.options ?? "",
    );
  }
  return fields;
}

/** What a block's settings say, cleaned. Two blocks that say the same thing are the same form. */
function definition(props) {
  const p = props && typeof props === "object" ? props : {};
  // The page builder keeps the fields as a list; a form written as one line of text (Name*; Email*:email) still works.
  const made = Array.isArray(p.fields)
    ? fieldsFromList(p.fields)
    : parseFields(typeof p.fields === "string" ? p.fields : "");
  const fields = made.length > 0 ? made : parseFields(DEFAULT_FIELDS);
  return {
    title: clean(p.title, 200),
    fields,
    submit: clean(p.button, 60) || "Send",
    thanks: clean(p.thanks, 500),
    thanks_page: clean(p.thanks_page, 200),
    send_to: clean(p.send_to, 500),
    note: clean(p.note, 300),
    confirm: p.confirm === true,
    confirm_text: clean(p.confirm_text, 1000),
  };
}

async function secretOf(ctx) {
  let secret = await ctx.storage.get("secrets", "hmac");
  if (typeof secret !== "string" || secret.length < 32) {
    secret = hex(crypto.getRandomValues(new Uint8Array(32)));
    await ctx.storage.set("secrets", "hmac", secret);
  }
  return secret;
}

/** The time the form was drawn, signed, so a program cannot send a form faster than a person (spec 15, section 4). */
async function makeToken(ctx, formId) {
  const at = Date.now();
  return `${at}.${(await hmac(await secretOf(ctx), `${formId}.${at}`)).slice(0, 32)}`;
}

/** "ok", "fast" (sent too soon after it was drawn), "old" (drawn long ago) or "invalid". */
async function readToken(ctx, formId, token) {
  const m = /^(\d{10,15})\.([0-9a-f]{32})$/.exec(token);
  if (!m) return "invalid";
  const want = (await hmac(await secretOf(ctx), `${formId}.${m[1]}`)).slice(0, 32);
  if (want !== m[2]) return "invalid";
  const age = Date.now() - Number(m[1]);
  if (age < MIN_SECONDS * 1000) return "fast";
  return age > 30 * DAY ? "old" : "ok";
}

const problem = (status, title, text) => ({ status, page: { title, text } });

const EMAIL = /^[^\s@,;<>]{1,64}@[^\s@,;<>]{1,190}\.[^\s@,;<>]{2,}$/;

/** What was sent for each field, or the plain sentences for what is wrong with it. */
function readValues(def, params, received) {
  const values = [];
  const errors = [];
  const files = [];
  for (const f of def.fields) {
    const all = params
      .getAll(f.name)
      // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
      .map((v) => v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""));
    let value;
    const fail = (why) => errors.push(`${f.label || f.name}: ${why}`);
    if (f.type === "hidden") value = f.value;
    else if (f.type === "file") {
      // The site read and checked the files; here are only references to those that came in this field.
      const mine = received.filter((x) => x.field === f.name);
      if (f.required && mine.length === 0) fail("choose a file.");
      files.push(...mine);
      value = mine.map((x) => x.name).join(", ");
    } else if (f.type === "consent") {
      value = all[0] === "yes" ? "yes" : "no";
      if (f.required && value !== "yes") fail("this must be ticked.");
    } else if (f.type === "checkbox") {
      const chosen = all.filter((v) => f.options.includes(v));
      if (chosen.length !== all.length) fail("this is not one of the choices.");
      if (f.required && chosen.length === 0) fail("choose at least one.");
      value = [...new Set(chosen)].join(", ");
    } else if (f.type === "radio" || f.type === "select") {
      value = all[0] ?? "";
      if (value !== "" && !f.options.includes(value)) fail("this is not one of the choices.");
      else if (f.required && value === "") fail("choose one.");
    } else {
      value = (all[0] ?? "").trim();
      if (value.length > (f.type === "textarea" ? 5000 : 500)) fail("this is too long.");
      else if (value === "") {
        if (f.required) fail("this is required.");
      } else if (f.type === "email" && !EMAIL.test(value)) fail("this is not an email address.");
      else if (f.type === "tel" && !/^[0-9+().\-\s]{5,30}$/.test(value))
        fail("this is not a phone number.");
      else if (
        f.type === "number" &&
        !(value !== "" && Number.isFinite(Number(value)) && Math.abs(Number(value)) < 1e15)
      )
        fail("this is not a number.");
      else if (
        f.type === "date" &&
        !(
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
        )
      )
        fail("this is not a date.");
    }
    values.push({ name: f.name, label: f.label || f.name, type: f.type, value });
  }
  return { values, errors, files };
}

/** Why a message looks like spam, or "" (spec 15, section 4: no outside service). */
async function spamReason(ctx, def, formId, params, values) {
  if ((params.get("_hp") ?? "") !== "") return "the hidden field was filled in";
  const timing = await readToken(ctx, formId, params.get("_t") ?? "");
  if (timing === "invalid") return "the form's signature was not valid";
  if (timing === "fast") return "it was sent faster than a person can";
  const text = values
    .map((v) => v.value)
    .join("\n")
    .toLowerCase();
  if ((text.match(/https?:\/\/|www\./g) ?? []).length > 2) return "it has too many links";
  const extra = String((await ctx.settings.get("blocked_words")) ?? "")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w !== "");
  const bad = [...DEFAULT_WORDS, ...extra].find((w) => text.includes(w));
  return bad ? "it has a word on the spam list" : "";
}

/** True when this form has been used too often this hour (counted per form, since the plugin never sees who sent it). */
async function tooOften(ctx, formId) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const row = await ctx.storage.get("rate", formId);
  const n = row && row.hour === hour ? row.n : 0;
  await ctx.storage.set("rate", formId, { hour, n: n + 1 });
  return n >= MOST_PER_HOUR;
}

const addresses = (text) =>
  String(text ?? "")
    .split(/[,;\s]+/)
    .filter((a) => EMAIL.test(a))
    .slice(0, 5);

async function trySend(ctx, to, subject, text) {
  try {
    await ctx.email.send({ to, subject, text });
  } catch (error) {
    await ctx.log(
      `email to ${to.replace(/^.*@/, "…@")} was not sent: ${String(error && error.message).slice(0, 100)}`,
    );
  }
}

/** Messages older than the keeping time are deleted, oldest first (the job that does it on a timer comes later). */
async function forget(ctx) {
  const months = Math.min(
    Math.max(Math.trunc(Number(await ctx.settings.get("keep_months")) || 12), 1),
    36,
  );
  const oldest = await ctx.storage.list("messages", { limit: 50, order: "asc" });
  let gone = 0;
  for (const row of oldest) {
    if (!(row.value && Number(row.value.at) < Date.now() - months * 30 * DAY)) break;
    await ctx.storage.delete("messages", row.key);
    gone += 1;
  }
  return gone;
}

export default {
  jobs: {
    // Once a day, without waiting for a visitor: delete the messages that are past their keeping time, oldest first
    // (up to 1,000 in one run; the rest go in the next run).
    async keep(_info, ctx) {
      for (let round = 0; round < 20; round += 1) if ((await forget(ctx)) < 50) break;
    },
  },
  blocks: {
    form: {
      async render(props, ctx) {
        const def = definition(props);
        if (def.fields.length === 0) return null;
        const formId = (await sha256(JSON.stringify(def))).slice(0, 16);
        if (!(await ctx.storage.get("defs", formId))) await ctx.storage.set("defs", formId, def);
        const contact = def.fields.some((f) => f.type === "email" || f.type === "tel");
        const privacy = clean(await ctx.settings.get("privacy_page"), 200);
        const link = contact && /^(\/(?![/\\])|https:\/\/)\S*$/.test(privacy) ? privacy : "";
        return {
          id: `f${formId.slice(0, 12)}`,
          type: "form",
          props: {
            action: "/api/oks/plugins/forms/send",
            title: def.title,
            submit: def.submit,
            note: def.note || (link ? "How we use your details" : ""),
            noteHref: link,
            token: await makeToken(ctx, formId),
            formId,
            fields: def.fields,
          },
          content: null,
          children: [],
        };
      },
    },
  },
  routes: {
    async send(req, ctx) {
      const params = new URLSearchParams(req.body);
      const formId = params.get("_form") ?? "";
      const def = /^[0-9a-f]{16}$/.test(formId) ? await ctx.storage.get("defs", formId) : null;
      if (!def || !Array.isArray(def.fields))
        return problem(
          404,
          "This form is not available",
          "Go back, reload the page and try again.",
        );
      const { values, errors, files } = readValues(def, params, req.files ?? []);
      const why = await spamReason(ctx, def, formId, params, values);
      if (
        (params.get("_t") ?? "") !== "" &&
        !why &&
        (await readToken(ctx, formId, params.get("_t"))) === "old"
      )
        return problem(
          400,
          "This page is out of date",
          "Go back, reload the page and send the form again.",
        );
      if (!why && errors.length > 0)
        return problem(400, "Please check your answers", errors.join("\n\n"));
      const thanks =
        def.thanks_page && /^\/(?![/\\])\S{0,200}$/.test(def.thanks_page)
          ? { redirect: def.thanks_page }
          : {
              page: { title: "Thank you", text: def.thanks || "Your message was sent. Thank you." },
            };
      // A program is told the same as a person: it learns nothing about why a message was kept apart.
      if (await tooOften(ctx, formId)) return thanks;
      const at = Date.now();
      const spam = why !== "";
      const shown = values
        .filter((v) => v.type !== "hidden")
        .map((v) => ({ label: v.label, value: spam ? v.value.slice(0, 200) : v.value }));
      // The addresses in the message, in one plain form, so the privacy tool can find a person's messages (spec 18, section 5).
      const emails = [
        ...new Set(
          values
            .filter((v) => v.type === "email" && EMAIL.test(v.value))
            .map((v) => v.value.trim().toLowerCase()),
        ),
      ];
      const message = {
        form: formId,
        title: def.title || "Form",
        emails,
        status: spam ? "spam" : "new",
        at,
        ...(spam ? { why } : {}),
        // One line for the Messages page: every answer with its label.
        // The files kept with the message (a message that was kept apart as spam keeps none).
        ...(!spam && files.length > 0
          ? { files: files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size })) }
          : {}),
        summary: shown
          .filter((v) => v.value !== "")
          .map((v) => `${v.label}: ${v.value}`)
          .join(" · ")
          .slice(0, 2000),
        values: shown,
      };
      const key = `${String(at).padStart(15, "0")}-${hex(crypto.getRandomValues(new Uint8Array(3)))}`;
      await ctx.storage.set("messages", key, message);
      // The files belong to the message from now on: they are deleted when it is. Files of a spam message are not kept.
      if (!spam && files.length > 0)
        await ctx.files.attach(
          files.map((f) => f.id),
          "messages",
          key,
        );
      await forget(ctx);
      if (!spam) {
        const owner = addresses(def.send_to || (await ctx.settings.get("send_to")));
        const title = def.title || "your website";
        const body = [
          `A message was sent from the form "${title}".`,
          "",
          ...message.values.map((v) => `${v.label}: ${v.value}`),
          ...(files.length > 0
            ? ["", "The files are kept privately. Open them in Tools > Plugins > Form messages."]
            : []),
          "",
          `Received: ${new Date(at).toISOString()}`,
        ].join("\n");
        for (const to of owner) await trySend(ctx, to, `New message: ${title}`.slice(0, 150), body);
        const sender = def.confirm
          ? values.find((v) => v.type === "email" && EMAIL.test(v.value))
          : undefined;
        if (sender)
          await trySend(
            ctx,
            sender.value,
            "We got your message",
            def.confirm_text || "Thank you. We got your message and will answer as soon as we can.",
          );
      }
      return thanks;
    },
  },
};
