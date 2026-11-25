// The words of the site's emails, which the owner can change (spec 13, section 6; D122). Each email has an original
// subject and text; an edited one is kept in `email_texts` and used instead, and "Reset to the original" deletes it.
// The text is simple: paragraphs (a blank line between them), lists ("- " at the start of a line), **bold**, *italic*
// and links written [label](https://…) or [label]({link}). Placeholders such as {name} are filled in with values that
// are always escaped, never read as markup. Each email lists the placeholders it cannot work without (a password reset
// needs {link}); a text without them is refused. Changes to security emails are written to the audit log.
import { newId, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export interface EmailTextDefinition {
  key: string;
  /** The plain name the owner sees. */
  title: string;
  /** Security emails help people into their account; plugins never change them, and edits are audited. */
  security: boolean;
  /** The placeholders this email offers. */
  placeholders: string[];
  /** The placeholders the text cannot do without. */
  required: string[];
  subject: string;
  body: string;
  /** Values for the preview and the test. */
  sample: Record<string, string>;
}

const SAMPLE_COMMON = { name: "Ben", site: "Your site" };

/** The original texts. The footer is added at the end of every email. */
export const EMAIL_TEXTS: EmailTextDefinition[] = [
  {
    key: "invitation",
    title: "Invitation to the site",
    security: false,
    placeholders: ["name", "site", "inviter", "role", "link", "days"],
    required: ["link"],
    subject: "You are invited to {site}",
    body: [
      "Hello {name},",
      "{inviter} invites you to work on {site} as {role}.",
      "Open the link to choose your own password. Nobody else learns it.",
      "[Accept the invitation]({link})",
      "The link works once, for {days}. If you did not expect this, you can ignore this email.",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      inviter: "Anna",
      role: "Editor",
      link: "https://example.com/admin/invite/sample",
      days: "7 days",
    },
  },
  {
    key: "password-reset",
    title: "Password reset",
    security: true,
    placeholders: ["name", "site", "link"],
    required: ["link"],
    subject: "Choose a new password for {site}",
    body: [
      "Hello {name},",
      "Someone asked to set a new password for your account on {site}. If it was you, open the link and choose a new password.",
      "[Choose a new password]({link})",
      "The link works for 1 hour and only once. If you did not ask for this, ignore this email: your password stays as it is.",
    ].join("\n\n"),
    sample: { ...SAMPLE_COMMON, link: "https://example.com/admin/reset-password?token=sample" },
  },
  {
    key: "account-password",
    title: "Your password was changed",
    security: true,
    placeholders: ["name", "site", "when", "link"],
    required: [],
    subject: "Your password was changed: {site}",
    body: [
      "Hello {name},",
      "The password of your account was changed, and you were signed out everywhere else. This happened on {when}.",
      "If it was you, there is nothing to do.",
      "If it was not you, someone may know your password: choose a new one at once and tell an administrator of the site.",
      "[Open your account]({link})",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      when: "Sat, 14 Nov 2026 10:00:00 GMT",
      link: "https://example.com/admin/account",
    },
  },
  {
    key: "account-two-factor-on",
    title: "Two-factor sign-in was turned on",
    security: true,
    placeholders: ["name", "site", "when", "link"],
    required: [],
    subject: "Two-factor sign-in was turned on: {site}",
    body: [
      "Hello {name},",
      "Two-factor sign-in was turned on for your account. Signing in now also asks for a code from your app. This happened on {when}.",
      "If it was you, there is nothing to do.",
      "If it was not you, someone may know your password: choose a new one at once and tell an administrator of the site.",
      "[Open your account]({link})",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      when: "Sat, 14 Nov 2026 10:00:00 GMT",
      link: "https://example.com/admin/account",
    },
  },
  {
    key: "account-two-factor-off",
    title: "Two-factor sign-in was turned off",
    security: true,
    placeholders: ["name", "site", "when", "link"],
    required: [],
    subject: "Two-factor sign-in was turned off: {site}",
    body: [
      "Hello {name},",
      "Two-factor sign-in was turned off for your account. Signing in now asks only for your password. This happened on {when}.",
      "If it was you, there is nothing to do.",
      "If it was not you, someone may know your password: choose a new one at once and tell an administrator of the site.",
      "[Open your account]({link})",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      when: "Sat, 14 Nov 2026 10:00:00 GMT",
      link: "https://example.com/admin/account",
    },
  },
  {
    key: "confirm-email",
    title: "Confirm your email address",
    security: true,
    placeholders: ["name", "site", "link"],
    required: ["link"],
    subject: "Confirm your email address for {site}",
    body: [
      "Hello {name},",
      "Please confirm that this is your email address for your account on {site}.",
      "[Confirm my address]({link})",
      "The link works for 1 hour. If you did not ask for this, ignore this email.",
    ].join("\n\n"),
    sample: { ...SAMPLE_COMMON, link: "https://example.com/api/auth/verify-email?token=sample" },
  },
  {
    key: "change-email-old",
    title: "Change of email address (to the old address)",
    security: true,
    placeholders: ["name", "site", "address", "link"],
    required: ["link"],
    subject: "Change the email address of your account on {site}?",
    body: [
      "Hello {name},",
      "Someone asked to change the email address of your account on {site} to {address}. If it was you, confirm it here; a second link then goes to the new address.",
      "[Yes, change my address]({link})",
      "If it was not you, do nothing: your address stays as it is. Then choose a new password, because someone may be signed in as you.",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      address: "ben.new@example.com",
      link: "https://example.com/api/auth/verify-email?token=sample",
    },
  },
  {
    key: "change-email-new",
    title: "Change of email address (to the new address)",
    security: true,
    placeholders: ["name", "site", "link"],
    required: ["link"],
    subject: "Confirm your new email address for {site}",
    body: [
      "Hello {name},",
      "Please confirm that this is the new email address for your account on {site}. Your account uses it once you open the link.",
      "[Confirm my new address]({link})",
      "The link works for 1 hour. If you did not ask for this, ignore this email.",
    ].join("\n\n"),
    sample: { ...SAMPLE_COMMON, link: "https://example.com/api/auth/verify-email?token=sample" },
  },
  {
    key: "account-email",
    title: "Your email address was changed",
    security: true,
    placeholders: ["name", "site", "when", "previous", "address", "link"],
    required: [],
    subject: "Your email address was changed: {site}",
    body: [
      "Hello {name},",
      "The email address of your account on {site} was changed from {previous} to {address}. This happened on {when}.",
      "If it was you, there is nothing to do.",
      "If it was not you, tell an administrator of the site at once.",
      "[Open your account]({link})",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      when: "Sat, 14 Nov 2026 10:00:00 GMT",
      previous: "ben@example.com",
      address: "ben.new@example.com",
      link: "https://example.com/admin/account",
    },
  },
  {
    key: "sign-in-link",
    title: "Sign-in link",
    security: true,
    placeholders: ["name", "site", "link"],
    required: ["link"],
    subject: "Your sign-in link for {site}",
    body: [
      "Hello {name},",
      "Here is the link to sign in to {site}. It signs in the browser you open it in.",
      "[Sign in]({link})",
      "The link works for 15 minutes and only once. If you did not ask for it, ignore this email: nobody can sign in without it.",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      link: "https://example.com/api/auth/magic-link/verify?token=sample",
    },
  },
  {
    key: "sign-in-link-refused",
    title: "No sign-in link for this account",
    security: true,
    placeholders: ["name", "site", "reason", "link"],
    required: ["reason"],
    subject: "About signing in to {site}",
    body: [
      "Hello {name},",
      "Someone asked for a sign-in link for your account on {site}. {reason}",
      "[Go to the sign-in page]({link})",
      "If you did not ask for it, ignore this email.",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      reason:
        "Your account uses two-factor sign-in, so sign-in links are off for it: sign in with your password and your code.",
      link: "https://example.com/admin/login",
    },
  },
  {
    key: "new-device",
    title: "Sign-in from a new device",
    security: true,
    placeholders: ["name", "site", "when", "browser", "address", "link"],
    required: [],
    subject: "A sign-in from a new device: {site}",
    body: [
      "Hello {name},",
      "Your account on {site} was signed in to from a device it had not seen before: {browser}, from the network address {address}, on {when}.",
      "If it was you, there is nothing to do.",
      "If it was not you, choose a new password at once, turn on two-factor sign-in, and tell an administrator of the site.",
      "[Open your account]({link})",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      when: "Sat, 14 Nov 2026 10:00:00 GMT",
      browser: "Firefox on Windows",
      address: "203.0.113.7",
      link: "https://example.com/admin/account",
    },
  },
  {
    key: "review-waiting",
    title: "A page waits for review",
    security: false,
    placeholders: ["name", "site", "title", "author", "link"],
    required: [],
    subject: "Waiting for review: {title}",
    body: [
      "Hello {name},",
      '{author} handed in "{title}" on {site} for review.',
      "[Open it to read, change or publish it]({link})",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      title: "Spring in the garden",
      author: "Anna",
      link: "https://example.com/admin/posts/sample",
    },
  },
  {
    key: "client-edit",
    title: "A client changed a live page",
    security: false,
    placeholders: ["name", "site", "title", "client", "link", "restore"],
    required: [],
    subject: "{client} changed a live page: {title}",
    body: [
      "Hello {name},",
      '{client} changed the live page "{title}" on {site}. The change is already on the site.',
      "[Look at the page]({link})",
      "If it should not stay, you can put the earlier version back with one click. Opening the link shows what would change and changes nothing until you press the button.",
      "[Put the earlier version back]({restore})",
      "The link works for 14 days. You get at most one of these emails for a page in half an hour.",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      title: "About us",
      client: "Chloé",
      link: "https://example.com/admin/pages/sample",
      restore: "https://example.com/admin/restore/sample",
    },
  },
  {
    key: "comment-waiting",
    title: "A comment waits for approval",
    security: false,
    placeholders: ["name", "site", "post", "commenter", "count", "link"],
    required: [],
    subject: "A comment waits for approval: {site}",
    body: [
      "Hello {name},",
      '{commenter} commented on "{post}" on {site}. {count} waiting for approval.',
      "[Read and approve comments]({link})",
      "You get at most one of these emails an hour, however many comments arrive.",
    ].join("\n\n"),
    sample: {
      ...SAMPLE_COMMON,
      post: "Spring in the garden",
      commenter: "Carla",
      count: "3 comments are",
      link: "https://example.com/admin/comments",
    },
  },
  {
    key: "footer",
    title: "The footer of every email",
    security: false,
    placeholders: ["site"],
    required: [],
    subject: "",
    body: "{site}",
    sample: { site: "Your site" },
  },
];

export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;
const PLACEHOLDER = /\{([a-z]+)\}/g;
const definition = (key: string) => EMAIL_TEXTS.find((t) => t.key === key) ?? null;

const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** What is wrong with a text, in plain words (EM-10); empty when it can be saved. */
export function emailTextProblems(key: string, subject: string, body: string): string[] {
  const def = definition(key);
  if (!def) return ["There is no such email."];
  const problems: string[] = [];
  if (key !== "footer") {
    if (!subject.trim()) problems.push("The subject cannot be empty.");
    if (subject.length > SUBJECT_MAX)
      problems.push(`The subject can be at most ${SUBJECT_MAX} characters.`);
    if (/[\r\n]/.test(subject)) problems.push("The subject must be one line.");
  }
  if (body.length > BODY_MAX) problems.push(`The text can be at most ${BODY_MAX} characters.`);
  if (key !== "footer" && !body.trim()) problems.push("The text cannot be empty.");
  const used = new Set([...`${subject}\n${body}`.matchAll(PLACEHOLDER)].map((m) => m[1]!));
  for (const name of used)
    if (!def.placeholders.includes(name))
      problems.push(
        `{${name}} is not a placeholder of this email. It offers: ${def.placeholders.map((p) => `{${p}}`).join(", ")}.`,
      );
  for (const name of def.required)
    if (!body.includes(`{${name}}`))
      problems.push(`The text must contain {${name}}: without it the email cannot do its job.`);
  for (const match of body.matchAll(/\[([^\]]*)\]\(([^)]*)\)/g)) {
    const target = match[2]!.trim();
    if (!/^https:\/\/[^\s<>"]+$/.test(target) && !/^\{[a-z]+\}$/.test(target))
      problems.push(
        `The link "${match[1]}" must start with https:// (or be a placeholder such as {link}).`,
      );
  }
  return problems;
}

/** Fills in one line of text with escaped values and turns **bold**, *italic* and links into HTML. */
function inlineHtml(line: string, values: Record<string, string>): string {
  const out: string[] = [];
  let at = 0;
  const link = /\[([^\]]*)\]\(([^)]*)\)/g;
  for (const m of line.matchAll(link)) {
    out.push(markHtml(line.slice(at, m.index), values));
    const target = fill(m[2]!.trim(), values);
    const label = markHtml(m[1]!, values);
    const primary = m[2]!.trim() === "{link}";
    out.push(
      /^https?:\/\/[^\s<>"]+$/.test(target)
        ? primary
          ? `<a href="${escape(target)}" style="display:inline-block;padding:12px 20px;background:#1f4d3a;color:#ffffff;text-decoration:none;border-radius:6px">${label}</a></p><p style="margin:0 0 16px;font-size:14px;color:#444444">${escape("If the button does not work, copy this address into your browser:")}<br>${escape(target)}`
          : `<a href="${escape(target)}">${label}</a>`
        : label,
    );
    at = m.index + m[0].length;
  }
  out.push(markHtml(line.slice(at), values));
  return out.join("");
}

/** Escapes the words and the values, then bold and italic. */
function markHtml(text: string, values: Record<string, string>): string {
  return escape(fill(text, values))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

const fill = (text: string, values: Record<string, string>) =>
  text.replace(PLACEHOLDER, (whole, name: string) => (name in values ? values[name]! : whole));

/** The plain text version: links become "label: address", marks are dropped. */
function inlineText(line: string, values: Record<string, string>): string {
  return fill(
    line
      .replace(
        /\[([^\]]*)\]\(([^)]*)\)/g,
        (_w, label: string, target: string) => `${label}: ${target.trim()}`,
      )
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1"),
    values,
  );
}

/** Turns a text (and the footer) into the plain text and the HTML of an email (EM-15: both, no tracking). */
export function renderEmailText(
  body: string,
  footer: string,
  values: Record<string, string>,
): { text: string; html: string } {
  const blocks = (source: string) =>
    source
      .replace(/\r\n/g, "\n")
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter(Boolean);
  const textOf = (source: string) =>
    blocks(source)
      .map((b) =>
        b
          .split("\n")
          .map((line) => inlineText(line, values))
          .join("\n"),
      )
      .join("\n\n");
  const htmlOf = (source: string, style: string) =>
    blocks(source)
      .map((b) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^- /.test(l)))
          return `<ul style="margin:0 0 16px">${lines.map((l) => `<li>${inlineHtml(l.slice(2), values)}</li>`).join("")}</ul>`;
        return `<p style="${style}">${lines.map((l) => inlineHtml(l, values)).join("<br>")}</p>`;
      })
      .join("");
  const text = [textOf(body), textOf(footer)].filter(Boolean).join("\n\n");
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;background:#ffffff">',
    '<div style="max-width:560px;margin:0 auto">',
    htmlOf(body, "margin:0 0 16px"),
    footer.trim()
      ? `<div style="margin:24px 0 0;color:#444444">${htmlOf(footer, "margin:0 0 8px")}</div>`
      : "",
    "</div></body></html>",
  ].join("");
  return { text, html };
}

/** The subject with its values (one line). */
export const renderSubject = (subject: string, values: Record<string, string>) =>
  fill(subject, values)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300);

// ----- stored texts

async function stored(
  runner: SqlRunner,
  siteId: string,
): Promise<Map<string, { subject: string; body: string; updatedAt: number }>> {
  const rows = await runner.all(
    `select "email_key", "subject", "body", "updated_at" from "email_texts" where "site_id" = ? and "locale" = ''`,
    [siteId],
  );
  return new Map(
    rows.map((r) => [
      String(r["email_key"]),
      {
        subject: String(r["subject"]),
        body: String(r["body"]),
        updatedAt: new Date(r["updated_at"] as string | number | Date).getTime(),
      },
    ]),
  );
}

/** The text an email uses now: the edited one when there is one that still passes the checks, else the original. */
export async function emailTextFor(
  runner: SqlRunner,
  siteId: string,
  key: string,
): Promise<{ subject: string; body: string; footer: string }> {
  const all = await stored(runner, siteId);
  const pick = (k: string) => {
    const def = definition(k)!;
    const edit = all.get(k);
    return edit && emailTextProblems(k, edit.subject, edit.body).length === 0
      ? edit
      : { subject: def.subject, body: def.body };
  };
  const text = pick(key);
  return { subject: text.subject, body: text.body, footer: pick("footer").body };
}

export interface EmailTextView extends EmailTextDefinition {
  /** True when the owner changed it. */
  edited: boolean;
  /** What is used now. */
  currentSubject: string;
  currentBody: string;
}

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string };
const forbidden: Fail = {
  ok: false,
  code: "forbidden",
  message: "You may not change the site settings.",
};

/** Every email with its original and current text. */
export async function listEmailTexts(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
): Promise<{ ok: true; texts: EmailTextView[] } | Fail> {
  if (!actor.can("settings.manage")) return forbidden;
  const all = await stored(runner, siteId);
  return {
    ok: true,
    texts: EMAIL_TEXTS.map((def) => {
      const edit = all.get(def.key);
      return {
        ...def,
        edited: !!edit,
        currentSubject: edit?.subject ?? def.subject,
        currentBody: edit?.body ?? def.body,
      };
    }),
  };
}

async function audit(runner: SqlRunner, actor: Actor, siteId: string, key: string, action: string) {
  await runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id",
      "detail", "created_at") values (?, ?, 'user', ?, ?, 'email_text', ?, ?, ?)`,
    [newId(), siteId, actor.userId, action, key, JSON.stringify({ key }), new Date()],
  );
}

/** Saves a changed text after the checks (EM-10). A security email's change is written to the audit log. */
export async function saveEmailText(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  key: string,
  input: { subject?: unknown; body?: unknown },
  now: () => number = Date.now,
): Promise<{ ok: true } | Fail> {
  if (!actor.can("settings.manage")) return forbidden;
  const def = definition(key);
  if (!def) return { ok: false, code: "invalid", message: "There is no such email." };
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n").trim() : "";
  const problems = emailTextProblems(key, subject, body);
  if (problems.length > 0) return { ok: false, code: "invalid", message: problems.join(" ") };
  await runner.all(
    `insert into "email_texts" ("site_id", "email_key", "locale", "subject", "body", "updated_by", "updated_at")
      values (?, ?, '', ?, ?, ?, ?)
      on conflict ("site_id", "email_key", "locale") do update set "subject" = excluded."subject",
        "body" = excluded."body", "updated_by" = excluded."updated_by", "updated_at" = excluded."updated_at"`,
    [siteId, key, subject, body, actor.userId, new Date(now())],
  );
  if (def.security) await audit(runner, actor, siteId, key, "email_text.change");
  return { ok: true };
}

/** "Reset to the original": the edited text is removed (EM-11). */
export async function resetEmailText(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  key: string,
): Promise<{ ok: true } | Fail> {
  if (!actor.can("settings.manage")) return forbidden;
  const def = definition(key);
  if (!def) return { ok: false, code: "invalid", message: "There is no such email." };
  const gone = await runner.all(
    `delete from "email_texts" where "site_id" = ? and "email_key" = ? and "locale" = '' returning "email_key"`,
    [siteId, key],
  );
  if (def.security && gone.length > 0) await audit(runner, actor, siteId, key, "email_text.reset");
  return { ok: true };
}

/** The email made from a (maybe unsaved) text with the sample values, for the preview and "Send me a test". */
export function previewEmailText(
  key: string,
  subject: string,
  body: string,
  footer: string,
  siteName: string,
): { subject: string; text: string; html: string; problems: string[] } {
  const def = definition(key);
  const values = { ...(def?.sample ?? {}), site: siteName };
  const shown = key === "footer" ? definition("invitation")! : def;
  const problems = emailTextProblems(key, subject, body);
  const mainBody = key === "footer" ? shown!.body : body;
  const mainFooter = key === "footer" ? body : footer;
  const sampleValues = key === "footer" ? { ...shown!.sample, site: siteName } : values;
  return {
    subject: renderSubject(key === "footer" ? shown!.subject : subject, sampleValues),
    ...renderEmailText(mainBody, mainFooter, sampleValues),
    problems,
  };
}
