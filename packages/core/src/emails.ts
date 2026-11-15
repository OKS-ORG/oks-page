// The emails the site sends (spec 13, section 5), each as a plain text and a simple HTML version made from the same
// words. Every value put in (a name, the site's name, a link) is escaped, links are https (or the site's own address),
// there are no pictures that load from elsewhere, no tracking pixels and no click tracking. They go through the queue
// of email.ts. Security emails (password reset, a changed password or two-factor) cannot be changed by plugins.
import type { SqlRunner } from "@oks-page/db";
import { queueEmail } from "./email.js";
import { emailTextFor, renderEmailText, renderSubject } from "./email-texts.js";
import type { SiteSecrets } from "./secret-box.js";

/** At most this many password resets to one address in an hour (spec 13, section 7; EM-13). */
export const RESET_LIMIT_PER_HOUR = 3;
/** How long a password reset link works. */
export const RESET_LINK_SECONDS = 60 * 60;

type Sent = { sent: true } | { sent: false; reason: string };

const done = (result: Awaited<ReturnType<typeof queueEmail>>): Sent =>
  result.queued ? { sent: true } : { sent: false, reason: result.reason };

/** An email made from its text (the owner's, or the original) with the values filled in, then queued. */
async function sendText(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  key: string,
  to: string,
  values: Record<string, string>,
  now: () => number,
  expiresAt?: number,
): Promise<Sent> {
  const text = await emailTextFor(runner, siteId, key);
  return done(
    await queueEmail(
      runner,
      siteId,
      secrets,
      {
        key,
        to,
        subject: renderSubject(text.subject, values),
        ...renderEmailText(text.body, text.footer, values),
        ...(expiresAt ? { expiresAt } : {}),
      },
      now,
    ),
  );
}

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
  return sendText(
    runner,
    siteId,
    secrets,
    "invitation",
    input.to,
    {
      name: input.name,
      site: input.siteName,
      inviter: input.inviter,
      role: input.role,
      link: input.link,
      days: days === 1 ? "1 day" : `${days} days`,
    },
    now,
    input.expiresAt,
  );
}

/** True when this email already went to this address 3 times in the last hour (EM-13). */
async function overLimit(
  runner: SqlRunner,
  siteId: string,
  key: string,
  to: string,
  now: () => number,
) {
  const recent = await runner.all(
    `select count(*) as n from "email_log" where "site_id" = ? and "email_key" = ?
      and lower("to_address") = ? and "created_at" >= ?`,
    [siteId, key, to.trim().toLowerCase(), new Date(now() - 60 * 60 * 1000)],
  );
  return Number(recent[0]?.["n"] ?? 0) >= RESET_LIMIT_PER_HOUR;
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
  if (await overLimit(runner, siteId, "password-reset", input.to, now))
    return { sent: false, reason: "Too many password resets for this address in the last hour." };
  return sendText(
    runner,
    siteId,
    secrets,
    "password-reset",
    input.to,
    { name: input.name || input.to, site: input.siteName, link: input.link },
    now,
    now() + RESET_LINK_SECONDS * 1000,
  );
}

/** Which link about an address: confirm it, confirm a change from the old address, or confirm the new address. */
export type AddressLink = "confirm-email" | "change-email-old" | "change-email-new";

/**
 * A link about an email address (security emails, spec 13, section 5). At most 3 of each kind to one address in an
 * hour; the link works for 1 hour, and an expired one is never sent late.
 */
export async function sendAddressLinkEmail(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  input: {
    kind: AddressLink;
    to: string;
    name: string;
    siteName: string;
    link: string;
    address?: string;
  },
  now: () => number = Date.now,
): Promise<Sent> {
  if (await overLimit(runner, siteId, input.kind, input.to, now))
    return { sent: false, reason: "Too many of these emails to this address in the last hour." };
  return sendText(
    runner,
    siteId,
    secrets,
    input.kind,
    input.to,
    {
      name: input.name || input.to,
      site: input.siteName,
      link: input.link,
      ...(input.address ? { address: input.address } : {}),
    },
    now,
    now() + RESET_LINK_SECONDS * 1000,
  );
}

/** How long a sign-in link works. */
export const SIGN_IN_LINK_MINUTES = 15;

const REFUSED_REASON = {
  "two-factor":
    "Your account uses two-factor sign-in, so sign-in links are off for it: sign in with your password and your code.",
  "not-confirmed":
    "Sign-in links work only for a confirmed email address. Sign in with your password, then confirm your address under Your account; after that you can use sign-in links.",
} as const;

/**
 * A sign-in link, or the reason there is none (security emails, spec 13, section 5). At most 3 to one address in an
 * hour; the link works for 15 minutes and is never sent late.
 */
export async function sendSignInLinkEmail(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  input: { to: string; name: string; siteName: string; loginLink: string } & (
    { link: string } | { refused: keyof typeof REFUSED_REASON }
  ),
  now: () => number = Date.now,
): Promise<Sent> {
  const key = "link" in input ? "sign-in-link" : "sign-in-link-refused";
  if (await overLimit(runner, siteId, key, input.to, now))
    return { sent: false, reason: "Too many sign-in links for this address in the last hour." };
  const common = { name: input.name || input.to, site: input.siteName };
  return "link" in input
    ? sendText(
        runner,
        siteId,
        secrets,
        key,
        input.to,
        { ...common, link: input.link },
        now,
        now() + SIGN_IN_LINK_MINUTES * 60_000,
      )
    : sendText(
        runner,
        siteId,
        secrets,
        key,
        input.to,
        { ...common, reason: REFUSED_REASON[input.refused], link: input.loginLink },
        now,
      );
}

/** "A sign-in from a new device" (a security email, spec 13, section 5). */
export async function sendNewDeviceEmail(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  input: {
    to: string;
    name: string;
    siteName: string;
    when: number;
    browser: string;
    address: string;
    accountLink: string;
  },
  now: () => number = Date.now,
): Promise<Sent> {
  return sendText(
    runner,
    siteId,
    secrets,
    "new-device",
    input.to,
    {
      name: input.name || input.to,
      site: input.siteName,
      when: new Date(input.when).toUTCString(),
      browser: input.browser,
      address: input.address || "unknown",
      link: input.accountLink,
    },
    now,
  );
}

/** What changed in an account, for the security notice. */
export type AccountChange = "password" | "two-factor-on" | "two-factor-off" | "email";

/** "Your password (or two-factor) was changed" (a security email, spec 13, section 5). */
export async function sendAccountChangeEmail(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  input: {
    to: string;
    name: string;
    siteName: string;
    change: AccountChange;
    accountLink: string;
    /** For an email change: the old and the new address. */
    previous?: string;
    address?: string;
  },
  now: () => number = Date.now,
): Promise<Sent> {
  return sendText(
    runner,
    siteId,
    secrets,
    `account-${input.change}`,
    input.to,
    {
      name: input.name || input.to,
      site: input.siteName,
      when: new Date(now()).toUTCString(),
      link: input.accountLink,
      ...(input.previous ? { previous: input.previous } : {}),
      ...(input.address ? { address: input.address } : {}),
    },
    now,
  );
}
