import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  EMAIL_JOB,
  emailJobHandler,
  listEmailLog,
  saveEmailSettings,
  type MakeTransport,
  type OutgoingEmail,
} from "./email.js";
import {
  RESET_LIMIT_PER_HOUR,
  sendAccountChangeEmail,
  sendInvitationEmail,
  sendPasswordResetEmail,
} from "./emails.js";
import { drainJobs } from "./jobs.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the emails`, () => {
    let db: TestDb;
    let siteId = "";
    const secrets = new SiteSecrets("x".repeat(40));
    let sent: OutgoingEmail[];
    const accepting: MakeTransport = () => ({
      send: async (email) => {
        sent.push(email);
      },
    });
    const send = () =>
      drainJobs(db.runner, {
        [EMAIL_JOB]: emailJobHandler(db.runner, secrets, { makeTransport: accepting }),
      });

    beforeEach(async () => {
      sent = [];
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
      const admin = actorOf(setup.userId, "administrator");
      const saved = await saveEmailSettings(
        db.runner,
        admin,
        siteId,
        secrets,
        {
          host: "smtp.example.com",
          port: 587,
          security: "starttls",
          username: "u",
          password: "p",
          fromName: "Anna's Garden",
          fromAddress: "hello@annas-garden.example",
          testTo: "anna@example.com",
        },
        { makeTransport: accepting },
      );
      expect(saved.ok).toBe(true);
      sent = [];
    });
    afterEach(async () => db.close());

    test("the invitation: who invites, the role, the link and how long it works", async () => {
      const now = () => T.getTime();
      expect(
        await sendInvitationEmail(
          db.runner,
          siteId,
          secrets,
          {
            to: "ben@example.com",
            name: "Ben",
            inviter: "Anna",
            siteName: "Anna's Garden",
            role: "Editor",
            link: "https://garden.example/admin/invite/abc",
            expiresAt: T.getTime() + 7 * 24 * 60 * 60 * 1000,
          },
          now,
        ),
      ).toEqual({ sent: true });
      await drainJobs(
        db.runner,
        {
          [EMAIL_JOB]: emailJobHandler(db.runner, secrets, { makeTransport: accepting, now }),
        },
        { now },
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        to: "ben@example.com",
        subject: "You are invited to Anna's Garden",
      });
      expect(sent[0]!.text).toContain("Anna invites you to work on Anna's Garden as Editor.");
      expect(sent[0]!.text).toContain(
        "Accept the invitation: https://garden.example/admin/invite/abc",
      );
      expect(sent[0]!.text).toContain("The link works once, for 7 days.");
      expect(sent[0]!.html).toContain('href="https://garden.example/admin/invite/abc"');
    });

    test("a password reset: the link and its hour; at most 3 an hour to one address (EM-13); dropped when late (EM-07)", async () => {
      let clock = T.getTime();
      const now = () => clock;
      const reset = () =>
        sendPasswordResetEmail(
          db.runner,
          siteId,
          secrets,
          {
            to: "Anna@Example.com",
            name: "Anna",
            siteName: "Anna's Garden",
            link: "https://garden.example/admin/reset-password?token=t1",
          },
          now,
        );
      for (let i = 0; i < RESET_LIMIT_PER_HOUR; i++) expect(await reset()).toEqual({ sent: true });
      expect(await reset()).toEqual({
        sent: false,
        reason: "Too many password resets for this address in the last hour.",
      });
      await drainJobs(
        db.runner,
        {
          [EMAIL_JOB]: emailJobHandler(db.runner, secrets, { makeTransport: accepting, now }),
        },
        { now },
      );
      expect(sent).toHaveLength(3);
      expect(sent[0]).toMatchObject({ subject: "Choose a new password for Anna's Garden" });
      expect(sent[0]!.text).toContain(
        "Choose a new password: https://garden.example/admin/reset-password?token=t1",
      );
      expect(sent[0]!.text).toContain("The link works for 1 hour and only once.");
      // An hour later, a new one may go.
      clock += 61 * 60 * 1000;
      expect(await reset()).toEqual({ sent: true });
      // Not sent before its link ran out: dropped, never late.
      clock += 61 * 60 * 1000;
      sent = [];
      await drainJobs(
        db.runner,
        {
          [EMAIL_JOB]: emailJobHandler(db.runner, secrets, { makeTransport: accepting, now }),
        },
        { now },
      );
      expect(sent).toEqual([]);
      const admin = actorOf("x", "administrator");
      const log = await listEmailLog(db.runner, admin, siteId, now);
      expect(
        log.ok &&
          log.rows
            .filter((r) => r.emailKey === "password-reset")
            .map((r) => r.status)
            .sort(),
      ).toEqual(["dropped", "sent", "sent", "sent"]);
    });

    test("the security notices: a changed password, two-factor on and off", async () => {
      for (const change of ["password", "two-factor-on", "two-factor-off"] as const)
        expect(
          await sendAccountChangeEmail(db.runner, siteId, secrets, {
            to: "anna@example.com",
            name: "Anna",
            siteName: "Anna's Garden",
            change,
            accountLink: "https://garden.example/admin/account",
          }),
        ).toEqual({ sent: true });
      await send();
      expect(sent.map((m) => m.subject)).toEqual([
        "Your password was changed: Anna's Garden",
        "Two-factor sign-in was turned on: Anna's Garden",
        "Two-factor sign-in was turned off: Anna's Garden",
      ]);
      expect(sent[0]!.text).toContain("If it was not you, someone may know your password");
      expect(sent[0]!.text).toContain("Open your account: https://garden.example/admin/account");
    });
  });
}
