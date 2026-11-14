// Sending email (spec 13; D122). One mail adapter with SMTP behind it for now (the direct provider connections come
// before 1.0, behind the same adapter). Email is optional: it counts as working only after a test email was accepted by
// the provider (EM-01), and saving settings whose test fails keeps the old, working ones. The password is sealed with
// the site's secret and never shown again (EM-05). Every other email goes through the job queue, so the person's
// request never waits for the mail server (EM-06), with retries after 1, 5 and 30 minutes and then every hour for 24
// hours; an email whose link has expired by then is dropped, not sent late (EM-07). The email record keeps who, which
// email, the subject, when, the provider and the result for 30 days, and never the message text (EM-08).
import type { SqlRunner } from "@oks-page/db";
import { newId } from "@oks-page/db";
import nodemailer from "nodemailer";
import type { Actor } from "./content.js";
import { enqueueJob, PermanentJobError, type Job, type JobHandler } from "./jobs.js";
import type { SiteSecrets } from "./secret-box.js";

export const EMAIL_SETTINGS_KEY = "email";
export const EMAIL_JOB = "email.send";
/** How long the email record keeps a row. */
export const EMAIL_LOG_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
/** Retries: after 1, 5 and 30 minutes, then every hour, for 24 hours in all. */
export const EMAIL_RETRY_DELAYS = [MINUTE, 5 * MINUTE, 30 * MINUTE];
const EMAIL_RETRY_FOR = DAY;
export const EMAIL_MAX_ATTEMPTS =
  1 +
  EMAIL_RETRY_DELAYS.length +
  Math.floor((EMAIL_RETRY_FOR - EMAIL_RETRY_DELAYS.reduce((a, b) => a + b, 0)) / (60 * MINUTE));

export function emailRetryDelay(attempts: number): number {
  return EMAIL_RETRY_DELAYS[attempts - 1] ?? 60 * MINUTE;
}

/** Ready settings for common providers (spec 13, section 4): the server and the port; the owner adds the rest. */
export const SMTP_PRESETS: {
  key: string;
  label: string;
  host: string;
  port: number;
  security: "starttls" | "tls";
}[] = [
  { key: "brevo", label: "Brevo", host: "smtp-relay.brevo.com", port: 587, security: "starttls" },
  {
    key: "postmark",
    label: "Postmark",
    host: "smtp.postmarkapp.com",
    port: 587,
    security: "starttls",
  },
  {
    key: "ses-eu",
    label: "Amazon SES (Europe, Ireland)",
    host: "email-smtp.eu-west-1.amazonaws.com",
    port: 587,
    security: "starttls",
  },
  {
    key: "ses-us",
    label: "Amazon SES (US East)",
    host: "email-smtp.us-east-1.amazonaws.com",
    port: 587,
    security: "starttls",
  },
  { key: "resend", label: "Resend", host: "smtp.resend.com", port: 465, security: "tls" },
  {
    key: "mailgun-eu",
    label: "Mailgun (Europe)",
    host: "smtp.eu.mailgun.org",
    port: 587,
    security: "starttls",
  },
  {
    key: "mailgun-us",
    label: "Mailgun (US)",
    host: "smtp.mailgun.org",
    port: 587,
    security: "starttls",
  },
  {
    key: "sendgrid",
    label: "SendGrid",
    host: "smtp.sendgrid.net",
    port: 587,
    security: "starttls",
  },
  { key: "mailjet", label: "Mailjet", host: "in-v3.mailjet.com", port: 587, security: "starttls" },
  {
    key: "scaleway",
    label: "Scaleway TEM",
    host: "smtp.tem.scaleway.com",
    port: 587,
    security: "starttls",
  },
  {
    key: "google",
    label: "Gmail and Google Workspace",
    host: "smtp.gmail.com",
    port: 587,
    security: "starttls",
  },
  {
    key: "microsoft",
    label: "Microsoft 365",
    host: "smtp.office365.com",
    port: 587,
    security: "starttls",
  },
];

/** What is stored in the settings (the password sealed). */
interface StoredEmailSettings {
  provider: string;
  host: string;
  port: number;
  security: "starttls" | "tls";
  username: string;
  /** The sealed password, or "" for none. */
  password: string;
  fromName: string;
  fromAddress: string;
  /** When the last test email was accepted. */
  testedAt: number;
}

/** What the settings screen shows: never the password, only whether there is one. */
export interface EmailSettingsView {
  provider: string;
  host: string;
  port: number;
  security: "starttls" | "tls";
  username: string;
  passwordSet: boolean;
  fromName: string;
  fromAddress: string;
  /** True when email works (a test email was accepted). */
  working: boolean;
  testedAt: number | null;
}

/** One email to send. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** What actually sends: SMTP now, a provider's own connection later. Throws a `MailError` in plain words. */
export interface MailTransport {
  send(email: OutgoingEmail, from: { name: string; address: string }): Promise<void>;
}

export class MailError extends Error {
  constructor(
    message: string,
    /** True when trying again cannot help (a wrong password, a refused address). */
    readonly permanent = false,
  ) {
    super(message);
    this.name = "MailError";
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  security: "starttls" | "tls";
  username: string;
  password: string;
}

/** Makes a transport from settings; tests give one that trusts their own certificate. */
export type MakeTransport = (config: SmtpConfig) => MailTransport;

/** The SMTP error in plain words. */
function plainSmtpError(error: unknown, config: SmtpConfig): MailError {
  const e = error as { code?: string; responseCode?: number; message?: string };
  const where = `${config.host}:${config.port}`;
  const text = String(e.message ?? "");
  if (e.code === "EAUTH")
    return new MailError("The mail server refused the user name or the password.", true);
  if (/STARTTLS/i.test(text) || e.code === "ETLS")
    return new MailError(
      `The mail server at ${where} does not offer an encrypted connection (TLS), so nothing was sent.`,
      true,
    );
  if (/certificate|self[- ]signed|CERT_/i.test(text) || /CERT/.test(String(e.code)))
    return new MailError(
      `The mail server at ${where} showed a certificate that cannot be trusted, so nothing was sent.`,
      true,
    );
  if (e.code === "EENVELOPE" || (e.responseCode && e.responseCode >= 550 && e.responseCode < 560))
    return new MailError("The mail server refused the address.", true);
  if (["ECONNECTION", "ESOCKET", "ETIMEDOUT", "EDNS", "ECONNREFUSED"].includes(String(e.code)))
    return new MailError(`The site could not reach the mail server at ${where}.`);
  if (e.responseCode && e.responseCode >= 400 && e.responseCode < 500)
    return new MailError("The mail server asked to try again later.");
  return new MailError(`The mail server at ${where} did not take the email.`);
}

/** SMTP with TLS only: TLS from the start (465) or STARTTLS, which must be offered (587); never plain (EM-03). */
export function smtpTransport(
  config: SmtpConfig,
  options: { ca?: string | Buffer } = {},
): MailTransport {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    ...(config.username ? { auth: { user: config.username, pass: config.password } } : {}),
    tls: { minVersion: "TLSv1.2", ...(options.ca ? { ca: options.ca } : {}) },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(email, from) {
      try {
        await transport.sendMail({
          from: { name: from.name, address: from.address },
          to: email.to,
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {}),
        });
      } catch (error) {
        throw plainSmtpError(error, config);
      } finally {
        transport.close();
      }
    },
  };
}

const defaultTransport: MakeTransport = (config) => smtpTransport(config);

// ----- the settings

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

async function loadStored(runner: SqlRunner, siteId: string): Promise<StoredEmailSettings | null> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, EMAIL_SETTINGS_KEY],
  );
  const value = decode(runner, rows[0]?.["value"]);
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<StoredEmailSettings>;
  if (typeof v.host !== "string" || typeof v.port !== "number" || typeof v.fromAddress !== "string")
    return null;
  return {
    provider: String(v.provider ?? "other"),
    host: v.host,
    port: v.port,
    security: v.security === "tls" ? "tls" : "starttls",
    username: String(v.username ?? ""),
    password: String(v.password ?? ""),
    fromName: String(v.fromName ?? ""),
    fromAddress: v.fromAddress,
    testedAt: Number(v.testedAt) || 0,
  };
}

const view = (s: StoredEmailSettings | null): EmailSettingsView | null =>
  s
    ? {
        provider: s.provider,
        host: s.host,
        port: s.port,
        security: s.security,
        username: s.username,
        passwordSet: s.password !== "",
        fromName: s.fromName,
        fromAddress: s.fromAddress,
        working: s.testedAt > 0,
        testedAt: s.testedAt || null,
      }
    : null;

/** The email settings for the screen (no password), or null when email is not set up. */
export async function loadEmailSettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
): Promise<
  | { ok: true; settings: EmailSettingsView | null }
  | { ok: false; code: "forbidden"; message: string }
> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  return { ok: true, settings: view(await loadStored(runner, siteId)) };
}

/** True when email works (EM-02: features that need it stay off until then). */
export async function emailWorks(runner: SqlRunner, siteId: string): Promise<boolean> {
  return ((await loadStored(runner, siteId))?.testedAt ?? 0) > 0;
}

const ADDRESS = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,253}\.[^\s@<>".]{2,63}$/;
const HOST =
  /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export interface EmailSettingsInput {
  provider?: unknown;
  host?: unknown;
  port?: unknown;
  security?: unknown;
  username?: unknown;
  /** A new password; empty or missing keeps the one saved before. */
  password?: unknown;
  fromName?: unknown;
  fromAddress?: unknown;
  /** Where the test email goes. */
  testTo?: unknown;
}

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

/**
 * Checks the settings, sends a test email with them, and saves them only when the provider accepted it (EM-01). When
 * it fails, the settings saved before (working or not) stay as they were and the reason is given in plain words.
 */
export async function saveEmailSettings(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  input: EmailSettingsInput,
  options: { makeTransport?: MakeTransport; now?: () => number; siteName?: string } = {},
): Promise<{ ok: true; settings: EmailSettingsView } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  const bad = (message: string, field: string): Fail => ({
    ok: false,
    code: "invalid",
    message,
    field,
  });
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const host = text(input.host);
  if (!HOST.test(host))
    return bad("Give the mail server's address, for example smtp.example.com.", "host");
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return bad("Give a port from 1 to 65535.", "port");
  const security =
    input.security === "tls" ? "tls" : input.security === "starttls" ? "starttls" : null;
  if (!security) return bad("Choose how the connection is encrypted.", "security");
  const username = text(input.username);
  if (username.length > 320) return bad("The user name is too long.", "username");
  const fromName = text(input.fromName).replace(/[\r\n]/g, " ");
  if (fromName.length > 80) return bad("The sender name can be at most 80 characters.", "fromName");
  const fromAddress = text(input.fromAddress);
  if (!ADDRESS.test(fromAddress)) return bad("Give the sender's email address.", "fromAddress");
  const testTo = text(input.testTo);
  if (!ADDRESS.test(testTo)) return bad("Give an address for the test email.", "testTo");
  const before = await loadStored(runner, siteId);
  const newPassword = typeof input.password === "string" ? input.password : "";
  if (newPassword.length > 1000) return bad("The password is too long.", "password");
  let password = newPassword;
  if (!password && before?.password) {
    try {
      password = secrets.open(before.password, "email:password");
    } catch {
      return bad("The saved password cannot be read any more. Type it again.", "password");
    }
  }
  const provider =
    typeof input.provider === "string" && SMTP_PRESETS.some((p) => p.key === input.provider)
      ? input.provider
      : "other";
  const config: SmtpConfig = { host, port, security, username, password };
  const now = options.now ?? Date.now;
  const subject = `Test email from ${options.siteName || "your site"}`;
  const logId = newId();
  await runner.all(
    `insert into "email_log" ("id", "site_id", "email_key", "to_address", "subject", "provider", "status", "attempts",
      "created_at", "last_attempt_at") values (?, ?, 'test', ?, ?, ?, 'queued', 1, ?, ?)`,
    [logId, siteId, testTo, subject, provider, new Date(now()), new Date(now())],
  );
  try {
    await (options.makeTransport ?? defaultTransport)(config).send(
      {
        to: testTo,
        subject,
        text: "This test shows that the site can send email. Password reset and invitations by email can now be used.",
      },
      { name: fromName, address: fromAddress },
    );
  } catch (error) {
    const reason = error instanceof MailError ? error.message : "The email could not be sent.";
    await runner.all(`update "email_log" set "status" = 'failed', "error" = ? where "id" = ?`, [
      reason,
      logId,
    ]);
    return {
      ok: false,
      code: "invalid",
      message: `The test email was not sent: ${reason} ${
        before?.testedAt ? "Your earlier settings are kept and still used." : "Email stays off."
      }`,
    };
  }
  await runner.all(`update "email_log" set "status" = 'sent' where "id" = ?`, [logId]);
  const stored: StoredEmailSettings = {
    provider,
    host,
    port,
    security,
    username,
    password: password ? secrets.seal(password, "email:password") : "",
    fromName,
    fromAddress,
    testedAt: now(),
  };
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, EMAIL_SETTINGS_KEY, JSON.stringify(stored), new Date(now())],
  );
  return { ok: true, settings: view(stored)! };
}

/** Turns email off: the settings (and the sealed password) are removed. */
export async function turnEmailOff(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
): Promise<{ ok: true } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  await runner.all(`delete from "settings" where "site_id" = ? and "key" = ?`, [
    siteId,
    EMAIL_SETTINGS_KEY,
  ]);
  return { ok: true };
}

// ----- the queue and the record

export interface QueuedEmail extends OutgoingEmail {
  /** Which email this is ("invitation", "password-reset"…), for the record. */
  key: string;
  /** When the email's link stops working: after that it is dropped instead of sent late. */
  expiresAt?: number;
}

/**
 * Puts an email in the queue (EM-06). The message is sealed in the job (the record never holds it) and the job's copy
 * is wiped once it was sent or given up. Returns false when email is not working, so the caller can say so.
 */
export async function queueEmail(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
  email: QueuedEmail,
  now: () => number = Date.now,
): Promise<{ queued: true; logId: string } | { queued: false; reason: string }> {
  const settings = await loadStored(runner, siteId);
  if (!settings?.testedAt)
    return { queued: false, reason: "Email is not set up, so this email cannot be sent." };
  if (!ADDRESS.test(email.to)) return { queued: false, reason: "That is not an email address." };
  // The record keeps 30 days.
  await runner.all(`delete from "email_log" where "site_id" = ? and "created_at" < ?`, [
    siteId,
    new Date(now() - EMAIL_LOG_DAYS * DAY),
  ]);
  const logId = newId();
  await runner.all(
    `insert into "email_log" ("id", "site_id", "email_key", "to_address", "subject", "provider", "status", "attempts",
      "created_at") values (?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
    [
      logId,
      siteId,
      email.key,
      email.to,
      email.subject.slice(0, 300),
      settings.provider,
      new Date(now()),
    ],
  );
  const message: OutgoingEmail = {
    to: email.to,
    subject: email.subject,
    text: email.text,
    ...(email.html ? { html: email.html } : {}),
  };
  await enqueueJob(
    runner,
    siteId,
    EMAIL_JOB,
    {
      logId,
      message: secrets.seal(JSON.stringify(message), `email:${logId}`),
      ...(email.expiresAt ? { expiresAt: email.expiresAt } : {}),
    },
    now,
    { maxAttempts: EMAIL_MAX_ATTEMPTS },
  );
  return { queued: true, logId };
}

/** The job that sends a queued email, with the retries of spec 13, section 7. */
export function emailJobHandler(
  runner: SqlRunner,
  secrets: SiteSecrets,
  options: { makeTransport?: MakeTransport; now?: () => number } = {},
): JobHandler {
  const now = options.now ?? Date.now;
  const wipe = (job: Job) =>
    runner.all(`update "jobs" set "payload" = ? where "id" = ?`, [JSON.stringify({}), job.id]);
  const mark = (logId: string, status: string, error: string | null) =>
    runner.all(
      `update "email_log" set "status" = ?, "error" = ?, "attempts" = "attempts" + 1, "last_attempt_at" = ? where "id" = ?`,
      [status, error, new Date(now()), logId],
    );
  return {
    retryDelay: emailRetryDelay,
    async run(job) {
      const payload = (job.payload ?? {}) as {
        logId?: string;
        message?: string;
        expiresAt?: number;
      };
      const logId = String(payload.logId ?? "");
      if (!payload.message) throw new PermanentJobError("The email is no longer in the queue.");
      if (payload.expiresAt && now() > payload.expiresAt) {
        // Its link has stopped working: sending it late would only confuse (EM-07).
        await runner.all(
          `update "email_log" set "status" = 'dropped', "error" = ?, "last_attempt_at" = ? where "id" = ?`,
          ["Its link had expired before it could be sent.", new Date(now()), logId],
        );
        await wipe(job);
        return;
      }
      const settings = await loadStored(runner, job.siteId);
      if (!settings?.testedAt) {
        await mark(logId, "failed", "Email was turned off before it could be sent.");
        await wipe(job);
        throw new PermanentJobError("Email is off.");
      }
      let message: OutgoingEmail;
      let password = "";
      try {
        message = JSON.parse(secrets.open(payload.message, `email:${logId}`)) as OutgoingEmail;
        if (settings.password) password = secrets.open(settings.password, "email:password");
      } catch {
        await mark(logId, "failed", "The site's secret changed, so the email could not be read.");
        await wipe(job);
        throw new PermanentJobError("The email cannot be opened.");
      }
      try {
        await (options.makeTransport ?? defaultTransport)({
          host: settings.host,
          port: settings.port,
          security: settings.security,
          username: settings.username,
          password,
        }).send(message, { name: settings.fromName, address: settings.fromAddress });
      } catch (error) {
        const plain =
          error instanceof MailError ? error : new MailError("The email could not be sent.");
        const last = plain.permanent || job.attempts >= job.maxAttempts;
        await mark(logId, last ? "failed" : "retrying", plain.message);
        if (last) await wipe(job);
        throw plain.permanent ? new PermanentJobError(plain.message) : plain;
      }
      await mark(logId, "sent", null);
      await wipe(job);
    },
  };
}

export interface EmailLogRow {
  id: string;
  emailKey: string;
  to: string;
  subject: string;
  provider: string;
  status: "queued" | "sent" | "retrying" | "failed" | "dropped";
  error: string | null;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number | null;
}

/** The email record, newest first (at most 200 rows, the last 30 days). */
export async function listEmailLog(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  now: () => number = Date.now,
): Promise<{ ok: true; rows: EmailLogRow[] } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  const rows = await runner.all(
    `select "id", "email_key", "to_address", "subject", "provider", "status", "error", "attempts", "created_at",
      "last_attempt_at" from "email_log" where "site_id" = ? and "created_at" >= ?
      order by "created_at" desc, "id" desc limit 200`,
    [siteId, new Date(now() - EMAIL_LOG_DAYS * DAY)],
  );
  const ms = (v: unknown) => (v == null ? null : new Date(v as string | number | Date).getTime());
  return {
    ok: true,
    rows: rows.map((r) => ({
      id: String(r["id"]),
      emailKey: String(r["email_key"]),
      to: String(r["to_address"]),
      subject: String(r["subject"]),
      provider: String(r["provider"]),
      status: String(r["status"]) as EmailLogRow["status"],
      error: r["error"] == null ? null : String(r["error"]),
      attempts: Number(r["attempts"]),
      createdAt: ms(r["created_at"])!,
      lastAttemptAt: ms(r["last_attempt_at"]),
    })),
  };
}
