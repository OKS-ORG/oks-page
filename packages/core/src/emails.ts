// The emails the site sends (spec 13, section 5), each as a plain text and a simple HTML version made from the same
// words. Every value put in (a name, the site's name, a link) is escaped, links are https (or the site's own address),
// there are no pictures that load from elsewhere, no tracking pixels and no click tracking. They go through the queue
// of email.ts. Security emails (password reset, a changed password or two-factor) cannot be changed by plugins.
import type { SqlRunner } from "@oks-page/db";
import { queueEmail } from "./email.js";
import type { SiteSecrets } from "./secret-box.js";

/** At most this many password resets to one address in an hour (spec 13, section 7; EM-13). */
export const RESET_LIMIT_PER_HOUR = 3;
/** How long a password reset link works. */
export const RESET_LINK_SECONDS = 60 * 60;

const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Only links that start with http(s) are written; anything else becomes plain text. */
const safeLink = (url: string): string | null => (/^https?:\/\/[^\s<>"]+$/.test(url) ? url : null);

export interface EmailParts {
  /** "Hello Ben," */
  greeting: string;
  paragraphs: string[];
  /** One button-like link, for the action the email is about. */
  action?: { label: string; url: string };
  /** Said after the action ("The link works for 1 hour."). */
  after?: string[];
  siteName: string;
}

/** The plain text and the HTML of an email, from the same words. */
export function composeEmail(parts: EmailParts): { text: string; html: string } {
  const link = parts.action ? safeLink(parts.action.url) : null;
  const lines = [
    parts.greeting,
    "",
    ...parts.paragraphs.flatMap((p) => [p, ""]),
    ...(parts.action ? [`${parts.action.label}: ${link ?? parts.action.url}`, ""] : []),
    ...(parts.after ?? []).flatMap((p) => [p, ""]),
    `${parts.siteName}`,
  ];
  const p = (t: string) => `<p style="margin:0 0 16px">${escape(t)}</p>`;
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;background:#ffffff">',
    '<div style="max-width:560px;margin:0 auto">',
    p(parts.greeting),
    ...parts.paragraphs.map(p),
    parts.action && link
      ? `<p style="margin:24px 0"><a href="${escape(link)}" style="display:inline-block;padding:12px 20px;background:#1f4d3a;color:#ffffff;text-decoration:none;border-radius:6px">${escape(parts.action.label)}</a></p><p style="margin:0 0 16px;font-size:14px;color:#444444">${escape("If the button does not work, copy this address into your browser:")}<br>${escape(link)}</p>`
      : "",
    ...(parts.after ?? []).map(p),
    `<p style="margin:24px 0 0;color:#444444">${escape(parts.siteName)}</p>`,
    "</div></body></html>",
  ].join("");
  return { text: lines.join("\n"), html };
}

type Sent = { sent: true } | { sent: false; reason: string };

const done = (result: Awaited<ReturnType<typeof queueEmail>>): Sent =>
  result.queued ? { sent: true } : { sent: false, reason: result.reason };

/** The invitation to join the site (spec 02; spec 13, section 5). */
export async function sendInvitationEmail(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  input: {
    to: string;
    name: string;
    inviter: string;
    siteName: string;
    role: string;
    link: string;
    expiresAt: number;
  },
  now: () => number = Date.now,
): Promise<Sent> {
  const days = Math.max(1, Math.round((input.expiresAt - now()) / (24 * 60 * 60 * 1000)));
  const body = composeEmail({
    siteName: input.siteName,
    greeting: `Hello ${input.name},`,
    paragraphs: [
      `${input.inviter} invites you to work on ${input.siteName} as ${input.role}.`,
      "Open the link to choose your own password. Nobody else learns it.",
    ],
    action: { label: "Accept the invitation", url: input.link },
    after: [
      `The link works once, for ${days === 1 ? "1 day" : `${days} days`}. If you did not expect this, you can ignore this email.`,
    ],
  });
  return done(
    await queueEmail(
      runner,
      siteId,
      secrets,
      {
        key: "invitation",
        to: input.to,
        subject: `You are invited to ${input.siteName}`,
        ...body,
        expiresAt: input.expiresAt,
      },
      now,
    ),
  );
}

/**
 * The password reset link (a security email). At most 3 to one address in an hour (EM-13); past that nothing is sent,
 * and the page still gives the same answer, so nobody can learn which addresses have an account.
 */
export async function sendPasswordResetEmail(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  input: { to: string; name: string; siteName: string; link: string },
  now: () => number = Date.now,
): Promise<Sent> {
  const recent = await runner.all(
    `select count(*) as n from "email_log" where "site_id" = ? and "email_key" = 'password-reset'
      and lower("to_address") = ? and "created_at" >= ?`,
    [siteId, input.to.trim().toLowerCase(), new Date(now() - 60 * 60 * 1000)],
  );
  if (Number(recent[0]?.["n"] ?? 0) >= RESET_LIMIT_PER_HOUR)
    return { sent: false, reason: "Too many password resets for this address in the last hour." };
  const body = composeEmail({
    siteName: input.siteName,
    greeting: `Hello ${input.name || input.to},`,
    paragraphs: [
      `Someone asked to set a new password for your account on ${input.siteName}. If it was you, open the link and choose a new password.`,
    ],
    action: { label: "Choose a new password", url: input.link },
    after: [
      "The link works for 1 hour and only once. If you did not ask for this, ignore this email: your password stays as it is.",
    ],
  });
  return done(
    await queueEmail(
      runner,
      siteId,
      secrets,
      {
        key: "password-reset",
        to: input.to,
        subject: `Choose a new password for ${input.siteName}`,
        ...body,
        expiresAt: now() + RESET_LINK_SECONDS * 1000,
      },
      now,
    ),
  );
}

/** What changed in an account, for the security notice. */
export type AccountChange = "password" | "two-factor-on" | "two-factor-off";

const CHANGE_WORDS: Record<AccountChange, { subject: string; said: string }> = {
  password: {
    subject: "Your password was changed",
    said: "The password of your account was changed, and you were signed out everywhere else.",
  },
  "two-factor-on": {
    subject: "Two-factor sign-in was turned on",
    said: "Two-factor sign-in was turned on for your account. Signing in now also asks for a code from your app.",
  },
  "two-factor-off": {
    subject: "Two-factor sign-in was turned off",
    said: "Two-factor sign-in was turned off for your account. Signing in now asks only for your password.",
  },
};

/** "Your password (or two-factor) was changed" (a security email, spec 13, section 5). */
export async function sendAccountChangeEmail(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  input: { to: string; name: string; siteName: string; change: AccountChange; accountLink: string },
  now: () => number = Date.now,
): Promise<Sent> {
  const words = CHANGE_WORDS[input.change];
  const body = composeEmail({
    siteName: input.siteName,
    greeting: `Hello ${input.name || input.to},`,
    paragraphs: [
      `${words.said} This happened on ${new Date(now()).toUTCString()}.`,
      "If it was you, there is nothing to do.",
      "If it was not you, someone may know your password: choose a new one at once and tell an administrator of the site.",
    ],
    action: { label: "Open your account", url: input.accountLink },
  });
  return done(
    await queueEmail(
      runner,
      siteId,
      secrets,
      {
        key: `account-${input.change}`,
        to: input.to,
        subject: `${words.subject}: ${input.siteName}`,
        ...body,
      },
      now,
    ),
  );
}
