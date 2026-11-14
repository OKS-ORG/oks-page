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

/** What changed in an account, for the security notice. */
export type AccountChange = "password" | "two-factor-on" | "two-factor-off";

/** "Your password (or two-factor) was changed" (a security email, spec 13, section 5). */
export async function sendAccountChangeEmail(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  input: { to: string; name: string; siteName: string; change: AccountChange; accountLink: string },
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
    },
    now,
  );
}
