// Will the site's emails reach the inbox? (spec 13, section 8; EM-14). After the email settings are saved, and once a
// day, the site looks up the sender domain's public SPF, DKIM and DMARC records. A missing or wrong record is shown in
// plain steps; the check only warns and never stops sending. A sender on a free mail domain (gmail.com…) through
// another provider gets a warning too, because such emails are often refused. The email health check also lives here:
// three failures in a row, or an email still failing after an hour, is shown in the admin (EM-09).
import { promises as dnsPromises } from "node:dns";
import type { SqlRunner } from "@oks-page/db";

export const DOMAIN_CHECK_KEY = "email-domain-check";
const DAY = 24 * 60 * 60 * 1000;

export type CheckStatus = "ok" | "warn" | "unknown";
export interface DomainCheckItem {
  check: "spf" | "dkim" | "dmarc" | "free-mail";
  status: CheckStatus;
  /** What was found, in plain words. */
  message: string;
  /** What to do about it, in plain steps (only for a warning). */
  steps?: string;
}
export interface DomainCheck {
  domain: string;
  checkedAt: number;
  items: DomainCheckItem[];
}

/** Looks up TXT records; tests give their own. */
export type TxtResolver = (name: string) => Promise<string[][]>;
const realResolver: TxtResolver = (name) => dnsPromises.resolveTxt(name);

const FREE_MAIL = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.co.uk",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "proton.me",
  "protonmail.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "zoho.com",
  "rediffmail.com",
];
/** Providers that send for their own free addresses. */
const FREE_MAIL_OWNER: Record<string, string[]> = {
  google: ["gmail.com", "googlemail.com"],
  microsoft: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
};

/** What the SPF record of a sender domain must name for a provider that sends from the domain itself. */
const SPF_INCLUDE: Record<string, { include: string; label: string }> = {
  google: { include: "_spf.google.com", label: "Google" },
  microsoft: { include: "spf.protection.outlook.com", label: "Microsoft 365" },
  brevo: { include: "spf.brevo.com", label: "Brevo" },
  mailjet: { include: "spf.mailjet.com", label: "Mailjet" },
};

/** The DKIM selector a provider uses, where it is always the same. */
const DKIM_SELECTOR: Record<string, string> = {
  google: "google",
  brevo: "brevo1",
  resend: "resend",
  mailjet: "mailjet",
  sendgrid: "s1",
};

const joined = (records: string[][]) => records.map((chunks) => chunks.join(""));

async function lookup(
  resolve: TxtResolver,
  name: string,
): Promise<{ records: string[] } | { failed: true }> {
  try {
    return { records: joined(await resolve(name)) };
  } catch (error) {
    const code = (error as { code?: string }).code;
    // "No such name" and "no TXT record" both mean: there is none.
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") return { records: [] };
    return { failed: true };
  }
}

/** The checks for one sender address and provider. Never throws. */
export async function checkSenderDomain(
  fromAddress: string,
  provider: string,
  options: { resolve?: TxtResolver; now?: () => number } = {},
): Promise<DomainCheck> {
  const resolve = options.resolve ?? realResolver;
  const domain = fromAddress.split("@")[1]?.trim().toLowerCase() ?? "";
  const items: DomainCheckItem[] = [];
  const unknown = (check: DomainCheckItem["check"], what: string): DomainCheckItem => ({
    check,
    status: "unknown",
    message: `The ${what} of ${domain} could not be looked up just now. Try "Check again" later.`,
  });

  if (FREE_MAIL.includes(domain) && !(FREE_MAIL_OWNER[provider] ?? []).includes(domain))
    items.push({
      check: "free-mail",
      status: "warn",
      message: `The sender address is on ${domain}, a free mail service, but the emails go out through another provider. Many mail services refuse such emails or put them in spam.`,
      steps:
        "Use an address on your own domain (for example hello@your-site.com) as the sender, or send through the free mail service itself.",
    });

  // SPF: one TXT record on the domain that starts with v=spf1.
  const spf = await lookup(resolve, domain);
  if ("failed" in spf) items.push(unknown("spf", "SPF record"));
  else {
    const found = spf.records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
    const named = SPF_INCLUDE[provider];
    if (found.length === 0)
      items.push({
        check: "spf",
        status: "warn",
        message: `${domain} has no SPF record. Without it, your emails may land in spam.`,
        steps: `At the company that manages your domain's DNS, add a TXT record on ${domain} with the value ${named ? `"v=spf1 include:${named.include} ~all"` : "your email provider gives you (it starts with v=spf1)"}.`,
      });
    else if (found.length > 1)
      items.push({
        check: "spf",
        status: "warn",
        message: `${domain} has ${found.length} SPF records. A domain may have only one, so mail services ignore all of them.`,
        steps:
          "Join them into one TXT record that starts with v=spf1 and has every include: in it, then delete the others.",
      });
    else if (named && !found[0]!.toLowerCase().includes(`include:${named.include}`))
      items.push({
        check: "spf",
        status: "warn",
        message: `The SPF record of ${domain} does not name ${named.label}, so emails sent through it may land in spam.`,
        steps: `Add include:${named.include} to the SPF record, before the ~all or -all at its end.`,
      });
    else items.push({ check: "spf", status: "ok", message: `${domain} has an SPF record.` });
  }

  // DKIM: only where the provider's selector is known.
  const selector = DKIM_SELECTOR[provider];
  if (!selector)
    items.push({
      check: "dkim",
      status: "unknown",
      message:
        "DKIM cannot be checked from here for this provider: its record names change. Your provider's dashboard shows the records to add and whether they work.",
    });
  else {
    const dkim = await lookup(resolve, `${selector}._domainkey.${domain}`);
    if ("failed" in dkim) items.push(unknown("dkim", "DKIM record"));
    else if (dkim.records.some((r) => /v=DKIM1|k=rsa|p=/i.test(r)))
      items.push({
        check: "dkim",
        status: "ok",
        message: `${domain} has a DKIM record for your provider.`,
      });
    else
      items.push({
        check: "dkim",
        status: "warn",
        message: `No DKIM record was found at ${selector}._domainkey.${domain}. Without it, your emails may land in spam.`,
        steps:
          "In your email provider's dashboard, open the domain settings: it shows a DKIM record. Add it at the company that manages your domain's DNS.",
      });
  }

  // DMARC: a TXT record on _dmarc.<domain> that starts with v=DMARC1.
  const dmarc = await lookup(resolve, `_dmarc.${domain}`);
  if ("failed" in dmarc) items.push(unknown("dmarc", "DMARC record"));
  else if (dmarc.records.some((r) => /^v=DMARC1/i.test(r.trim())))
    items.push({ check: "dmarc", status: "ok", message: `${domain} has a DMARC record.` });
  else
    items.push({
      check: "dmarc",
      status: "warn",
      message: `${domain} has no DMARC record. Big mail services now expect one, and may put your emails in spam without it.`,
      steps: `Add a TXT record on _dmarc.${domain} with the value "v=DMARC1; p=none" to start. You can make it stricter later.`,
    });

  return { domain, checkedAt: (options.now ?? Date.now)(), items };
}

// ----- stored results

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

async function saveSetting(
  runner: SqlRunner,
  siteId: string,
  key: string,
  value: unknown,
  at: number,
) {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date(at)],
  );
}

async function readSetting(runner: SqlRunner, siteId: string, key: string): Promise<unknown> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  return decode(runner, rows[0]?.["value"]);
}

/** The last domain check, or null. */
export async function loadDomainCheck(
  runner: SqlRunner,
  siteId: string,
): Promise<DomainCheck | null> {
  const value = await readSetting(runner, siteId, DOMAIN_CHECK_KEY);
  if (!value || typeof value !== "object" || !Array.isArray((value as DomainCheck).items))
    return null;
  return value as DomainCheck;
}

/** Runs the check for the site's sender and keeps the result. Null when email is not set up. */
export async function runDomainCheck(
  runner: SqlRunner,
  siteId: string,
  options: { resolve?: TxtResolver; now?: () => number } = {},
): Promise<DomainCheck | null> {
  const settings = (await readSetting(runner, siteId, "email")) as {
    fromAddress?: string;
    provider?: string;
    testedAt?: number;
  } | null;
  if (!settings?.fromAddress || !settings.testedAt) return null;
  const result = await checkSenderDomain(
    settings.fromAddress,
    settings.provider ?? "other",
    options,
  );
  await saveSetting(runner, siteId, DOMAIN_CHECK_KEY, result, result.checkedAt);
  return result;
}

/** The daily check: runs only when the last one is a day old (or there is none). */
export async function runDailyDomainCheck(
  runner: SqlRunner,
  siteId: string,
  options: { resolve?: TxtResolver; now?: () => number } = {},
): Promise<boolean> {
  const now = (options.now ?? Date.now)();
  const last = await loadDomainCheck(runner, siteId);
  if (last && now - last.checkedAt < DAY) return false;
  return (await runDomainCheck(runner, siteId, options)) !== null;
}

// ----- the email health check (spec 13, section 7; EM-09)

export const EMAIL_ALERT_KEY = "email-alert-sent";

export interface EmailHealth {
  /** Null when email is fine. */
  problem: null | "failing" | "stuck";
  message: string;
}

/**
 * Whether emails keep failing: the last 3 emails (test emails aside) all failed, or an email is still being tried
 * after an hour.
 */
export async function emailHealth(
  runner: SqlRunner,
  siteId: string,
  now: () => number = Date.now,
): Promise<EmailHealth> {
  const last = await runner.all(
    `select "status" from "email_log" where "site_id" = ? and "email_key" <> 'test' and "status" <> 'queued'
      order by "created_at" desc, "id" desc limit 3`,
    [siteId],
  );
  if (last.length === 3 && last.every((r) => r["status"] === "failed"))
    return {
      problem: "failing",
      message:
        "The last 3 emails could not be sent. People may not get invitations or password resets. Check the email settings and the email record.",
    };
  const stuck = await runner.all(
    `select count(*) as n from "email_log" where "site_id" = ? and "status" = 'retrying' and "created_at" < ?`,
    [siteId, new Date(now() - 60 * 60 * 1000)],
  );
  if (Number(stuck[0]?.["n"] ?? 0) > 0)
    return {
      problem: "stuck",
      message:
        "An email has been failing for more than an hour; the site keeps trying for 24 hours. Check the email settings and the email record.",
    };
  return { problem: null, message: "" };
}

/**
 * When emails keep failing, tells every administrator by email once a day (it may well fail too; the admin shows it
 * anyway). Returns the addresses it queued for.
 */
export async function alertAdministrators(
  runner: SqlRunner,
  siteId: string,
  queue: (to: string, subject: string, text: string) => Promise<boolean>,
  now: () => number = Date.now,
): Promise<string[]> {
  const health = await emailHealth(runner, siteId, now);
  if (!health.problem) return [];
  const last = Number(await readSetting(runner, siteId, EMAIL_ALERT_KEY)) || 0;
  if (now() - last < DAY) return [];
  const admins = await runner.all(
    `select u."email" from "site_members" m join "users" u on u."id" = m."user_id"
      join "roles" r on r."id" = m."role_id" where m."site_id" = ? and r."key" = 'administrator'`,
    [siteId],
  );
  const sent: string[] = [];
  for (const a of admins) {
    const to = String(a["email"]);
    if (await queue(to, "Emails from your site are not going out", health.message)) sent.push(to);
  }
  await saveSetting(runner, siteId, EMAIL_ALERT_KEY, now(), now());
  return sent;
}
