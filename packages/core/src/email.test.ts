import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  EMAIL_JOB,
  EMAIL_MAX_ATTEMPTS,
  emailJobHandler,
  emailWorks,
  listEmailLog,
  loadEmailSettings,
  MailError,
  queueEmail,
  saveEmailSettings,
  SMTP_PRESETS,
  smtpTransport,
  turnEmailOff,
  type MakeTransport,
} from "./email.js";
import { drainJobs } from "./jobs.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

// A certificate for "localhost", made for this run only (the servers below use it; the transport trusts it).
let certDir = "";
let key = "";
let cert = "";
beforeAll(() => {
  certDir = mkdtempSync(path.join(tmpdir(), "oks-smtp-cert-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(certDir, "key.pem"),
      "-out",
      path.join(certDir, "cert.pem"),
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  key = readFileSync(path.join(certDir, "key.pem"), "utf8");
  cert = readFileSync(path.join(certDir, "cert.pem"), "utf8");
});
afterAll(() => rmSync(certDir, { recursive: true, force: true }));

interface Received {
  from: string;
  to: string[];
  data: string;
}

/** A local SMTP server: TLS from the start ("tls"), STARTTLS ("starttls"), or plain with no STARTTLS ("plain"). */
async function smtp(kind: "tls" | "starttls" | "plain") {
  const received: Received[] = [];
  const server = new SMTPServer({
    secure: kind === "tls",
    ...(kind === "plain" ? { disabledCommands: ["STARTTLS"] } : { key, cert }),
    authOptional: false,
    allowInsecureAuth: kind === "plain",
    onAuth(auth, _session, done) {
      if (auth.username === "anna" && auth.password === "right-password")
        done(null, { user: "anna" });
      else done(new Error("Invalid username or password"));
    },
    onData(stream, session, done) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          data: Buffer.concat(chunks).toString("utf8"),
        });
        done();
      });
    },
    logger: false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const trusting: MakeTransport = (config) => smtpTransport(config, { ca: cert });

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: email (spec 13)`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;
    const secrets = new SiteSecrets("x".repeat(40));
    const servers: { close: () => Promise<void> }[] = [];
    const server = async (k: "tls" | "starttls" | "plain") => {
      const s = await smtp(k);
      servers.push(s);
      return s;
    };
    /** The newest row of the email record for one kind of email. */
    const logRow = async (key: string, now?: () => number) => {
      const log = await listEmailLog(db.runner, admin, siteId, now);
      if (!log.ok) throw new Error(log.message);
      return log.rows.find((r) => r.emailKey === key);
    };
    const settings = (port: number, extra: Record<string, unknown> = {}) => ({
      provider: "other",
      host: "localhost",
      port,
      security: "starttls",
      username: "anna",
      password: "right-password",
      fromName: "Anna's Garden",
      fromAddress: "hello@annas-garden.example",
      testTo: "anna@example.com",
      ...extra,
    });

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const userId = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [userId, name, email, T, T],
          );
          return { userId };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      admin = actorOf(setup.userId, "administrator");
      editor = actorOf(setup.userId, "editor");
    });
    afterEach(async () => {
      await Promise.all(servers.splice(0).map((s) => s.close()));
      await db.close();
    });

    test("until a test email is accepted, email is off; then it works (EM-01, EM-02)", async () => {
      expect(await emailWorks(db.runner, siteId)).toBe(false);
      expect(await loadEmailSettings(db.runner, admin, siteId)).toEqual({
        ok: true,
        settings: null,
      });
      expect(
        await queueEmail(db.runner, siteId, secrets, {
          key: "invitation",
          to: "ben@example.com",
          subject: "x",
          text: "x",
        }),
      ).toEqual({ queued: false, reason: "Email is not set up, so this email cannot be sent." });

      const s = await server("starttls");
      const saved = await saveEmailSettings(db.runner, admin, siteId, secrets, settings(s.port), {
        makeTransport: trusting,
        siteName: "Anna's Garden",
      });
      expect(saved).toMatchObject({
        ok: true,
        settings: {
          host: "localhost",
          passwordSet: true,
          working: true,
          fromName: "Anna's Garden",
        },
      });
      expect(JSON.stringify(saved)).not.toContain("right-password");
      expect(await emailWorks(db.runner, siteId)).toBe(true);
      expect(s.received).toHaveLength(1);
      expect(s.received[0]!.to).toEqual(["anna@example.com"]);
      expect(s.received[0]!.data).toContain("Subject: Test email from Anna's Garden");

      // A failing test keeps the working settings (EM-01).
      const failed = await saveEmailSettings(
        db.runner,
        admin,
        siteId,
        secrets,
        settings(s.port, { password: "wrong", fromName: "Changed" }),
        { makeTransport: trusting },
      );
      expect(failed).toMatchObject({
        ok: false,
        message:
          "The test email was not sent: The mail server refused the user name or the password. Your earlier settings are kept and still used.",
      });
      expect(await loadEmailSettings(db.runner, admin, siteId)).toMatchObject({
        settings: { fromName: "Anna's Garden", working: true },
      });
      // Saving again without a password keeps the saved one.
      expect(
        await saveEmailSettings(
          db.runner,
          admin,
          siteId,
          secrets,
          settings(s.port, { password: "", fromName: "Anna" }),
          { makeTransport: trusting },
        ),
      ).toMatchObject({ ok: true, settings: { fromName: "Anna" } });

      // Turning it off.
      expect(await turnEmailOff(db.runner, admin, siteId)).toEqual({ ok: true });
      expect(await emailWorks(db.runner, siteId)).toBe(false);
    });

    test("only administrators; the fields are checked; the password is sealed and never shown (EM-05)", async () => {
      const s = await server("tls");
      expect(
        await saveEmailSettings(db.runner, editor, siteId, secrets, settings(s.port)),
      ).toMatchObject({ code: "forbidden" });
      expect(await loadEmailSettings(db.runner, editor, siteId)).toMatchObject({
        code: "forbidden",
      });
      for (const [extra, field] of [
        [{ host: "not a host" }, "host"],
        [{ port: 70000 }, "port"],
        [{ security: "none" }, "security"],
        [{ fromAddress: "nobody" }, "fromAddress"],
        [{ testTo: "" }, "testTo"],
      ] as const)
        expect(
          await saveEmailSettings(db.runner, admin, siteId, secrets, settings(s.port, extra)),
        ).toMatchObject({ ok: false, field });
      // TLS from the start (port 465 style).
      expect(
        await saveEmailSettings(
          db.runner,
          admin,
          siteId,
          secrets,
          settings(s.port, { security: "tls" }),
          { makeTransport: trusting },
        ),
      ).toMatchObject({ ok: true });
      const raw = JSON.stringify(await db.run("select value from settings where key = 'email'"));
      expect(raw).not.toContain("right-password");
      expect(raw).toMatch(/v1:/);
      // Sealed for the site's own secret: another secret cannot open it.
      const other = new SiteSecrets("y".repeat(40));
      // SQLite gives the JSON as text, PostgreSQL as a value.
      const value = (await db.run("select value from settings where key = 'email'"))[0]!["value"];
      const stored = (typeof value === "string" ? JSON.parse(value) : value) as {
        password: string;
      };
      expect(() => other.open(stored.password, "email:password")).toThrow();
      expect(secrets.open(stored.password, "email:password")).toBe("right-password");
    });

    test("a server without encryption is refused; a certificate that cannot be trusted too; the presets (EM-03)", async () => {
      const plain = await server("plain");
      expect(
        await saveEmailSettings(db.runner, admin, siteId, secrets, settings(plain.port), {
          makeTransport: trusting,
        }),
      ).toMatchObject({
        ok: false,
        message: expect.stringMatching(
          /does not offer an encrypted connection \(TLS\).*Email stays off\./,
        ),
      });
      expect(plain.received).toEqual([]);
      const tls = await server("starttls");
      expect(
        await saveEmailSettings(db.runner, admin, siteId, secrets, settings(tls.port), {
          // The normal transport, which does not trust this test certificate.
          makeTransport: (config) => smtpTransport(config),
        }),
      ).toMatchObject({
        ok: false,
        message: expect.stringMatching(/certificate that cannot be trusted/),
      });
      expect(await emailWorks(db.runner, siteId)).toBe(false);
      for (const preset of SMTP_PRESETS) {
        expect(preset.host).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
        expect([preset.port, preset.security]).toEqual(
          preset.port === 465 ? [465, "tls"] : [587, "starttls"],
        );
      }
      expect(SMTP_PRESETS.map((p) => p.key)).toEqual(
        expect.arrayContaining([
          "brevo",
          "postmark",
          "ses-eu",
          "resend",
          "mailgun-eu",
          "sendgrid",
          "mailjet",
          "scaleway",
          "google",
          "microsoft",
        ]),
      );
    });

    test("an email is queued, sent by the job, and the record never holds its text (EM-06, EM-08)", async () => {
      const s = await server("starttls");
      await saveEmailSettings(db.runner, admin, siteId, secrets, settings(s.port), {
        makeTransport: trusting,
      });
      const queued = await queueEmail(db.runner, siteId, secrets, {
        key: "invitation",
        to: "ben@example.com",
        subject: "You are invited",
        text: "Your link: https://example.com/secret-token-123",
      });
      expect(queued).toMatchObject({ queued: true });
      // Nothing is sent while the request runs.
      expect(s.received).toHaveLength(1); // the test email only
      expect(JSON.stringify(await db.run("select payload from jobs"))).not.toContain(
        "secret-token-123",
      );
      expect(await logRow("invitation")).toMatchObject({
        to: "ben@example.com",
        subject: "You are invited",
        status: "queued",
      });

      await drainJobs(db.runner, {
        [EMAIL_JOB]: emailJobHandler(db.runner, secrets, { makeTransport: trusting }),
      });
      expect(s.received).toHaveLength(2);
      expect(s.received[1]!.to).toEqual(["ben@example.com"]);
      expect(s.received[1]!.data).toContain("secret-token-123");
      expect(await logRow("invitation")).toMatchObject({
        status: "sent",
        attempts: 1,
        error: null,
      });
      // The job's copy of the message is wiped once it was sent; the record never had it.
      expect(JSON.stringify(await db.run("select * from jobs"))).not.toContain("secret-token-123");
      expect(JSON.stringify(await db.run("select * from email_log"))).not.toContain(
        "secret-token-123",
      );
      expect(await listEmailLog(db.runner, editor, siteId)).toMatchObject({ code: "forbidden" });
    });

    test("retries after 1, 5 and 30 minutes, then every hour for 24 hours; an expired link is dropped (EM-07)", async () => {
      const s = await server("starttls");
      await saveEmailSettings(db.runner, admin, siteId, secrets, settings(s.port), {
        makeTransport: trusting,
      });
      let clock = T.getTime();
      const now = () => clock;
      let calls = 0;
      const failing: MakeTransport = () => ({
        send: async () => {
          calls += 1;
          throw new MailError("The site could not reach the mail server at localhost:1.");
        },
      });
      await queueEmail(
        db.runner,
        siteId,
        secrets,
        { key: "notice", to: "ben@example.com", subject: "Hello", text: "Hello" },
        now,
      );
      const handler = emailJobHandler(db.runner, secrets, { makeTransport: failing, now });
      const runAt = async () =>
        new Date(
          (await db.run("select run_at from jobs where kind = ?", [EMAIL_JOB]))[0]![
            "run_at"
          ] as string,
        ).getTime();
      const gaps: number[] = [];
      for (let i = 0; i < 5; i++) {
        await drainJobs(db.runner, { [EMAIL_JOB]: handler }, { now });
        const next = await runAt();
        gaps.push(next - clock);
        clock = next;
      }
      expect(gaps).toEqual([60_000, 300_000, 1_800_000, 3_600_000, 3_600_000]);
      expect(await logRow("notice", now)).toMatchObject({
        status: "retrying",
        attempts: 5,
        error: "The site could not reach the mail server at localhost:1.",
      });
      // About 24 hours in all: 1 + 3 + 23 tries.
      expect(EMAIL_MAX_ATTEMPTS).toBe(27);
      for (let i = 5; i < EMAIL_MAX_ATTEMPTS; i++) {
        await drainJobs(db.runner, { [EMAIL_JOB]: handler }, { now });
        clock = await runAt();
      }
      expect(calls).toBe(EMAIL_MAX_ATTEMPTS);
      expect(await logRow("notice", now)).toMatchObject({
        status: "failed",
        attempts: EMAIL_MAX_ATTEMPTS,
      });

      // A password reset whose link expires before it can go out is dropped, never sent late.
      calls = 0;
      await queueEmail(
        db.runner,
        siteId,
        secrets,
        {
          key: "password-reset",
          to: "ben@example.com",
          subject: "Reset",
          text: "x",
          expiresAt: clock + 10_000,
        },
        now,
      );
      clock += 60_000;
      await drainJobs(db.runner, { [EMAIL_JOB]: handler }, { now });
      expect(calls).toBe(0);
      expect(await logRow("password-reset", now)).toMatchObject({
        status: "dropped",
        error: "Its link had expired before it could be sent.",
      });
    });

    test("a refused address is not tried again; the record keeps 30 days", async () => {
      const s = await server("starttls");
      await saveEmailSettings(db.runner, admin, siteId, secrets, settings(s.port), {
        makeTransport: trusting,
      });
      let calls = 0;
      const refusing: MakeTransport = () => ({
        send: async () => {
          calls += 1;
          throw new MailError("The mail server refused the address.", true);
        },
      });
      let clock = T.getTime();
      const now = () => clock;
      await queueEmail(
        db.runner,
        siteId,
        secrets,
        { key: "notice", to: "x@example.com", subject: "A", text: "A" },
        now,
      );
      await drainJobs(
        db.runner,
        { [EMAIL_JOB]: emailJobHandler(db.runner, secrets, { makeTransport: refusing, now }) },
        { now },
      );
      expect(calls).toBe(1);
      expect(await logRow("notice", now)).toMatchObject({
        status: "failed",
        error: "The mail server refused the address.",
      });
      // 31 days later the old rows are gone.
      clock += 31 * 24 * 60 * 60 * 1000;
      await queueEmail(
        db.runner,
        siteId,
        secrets,
        { key: "notice", to: "y@example.com", subject: "B", text: "B" },
        now,
      );
      const later = await listEmailLog(db.runner, admin, siteId, now);
      expect(
        later.ok && later.rows.filter((r) => r.emailKey === "notice").map((r) => r.to),
      ).toEqual(["y@example.com"]);
    });
  });
}
