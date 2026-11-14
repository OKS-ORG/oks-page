import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  alertAdministrators,
  checkSenderDomain,
  emailHealth,
  loadDomainCheck,
  runDailyDomainCheck,
  runDomainCheck,
  type TxtResolver,
} from "./email-domain.js";
import { saveEmailSettings, type MakeTransport } from "./email.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

/** A DNS with fixed TXT records; a name it does not know does not exist. */
const dns =
  (records: Record<string, string[]>, failing: string[] = []): TxtResolver =>
  async (name) => {
    if (failing.includes(name)) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    if (!(name in records)) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    // Long records come in pieces of at most 255 characters.
    return records[name]!.map((r) => [r.slice(0, 255), r.slice(255)].filter(Boolean));
  };
const byCheck = (items: { check: string; status: string; message: string; steps?: string }[]) =>
  Object.fromEntries(items.map((i) => [i.check, i]));

describe("the sender domain check (spec 13, section 8; EM-14)", () => {
  test("everything in place: SPF that names the provider, DKIM at its selector, DMARC", async () => {
    const result = await checkSenderDomain("hello@garden.example", "brevo", {
      resolve: dns({
        "garden.example": ["google-site-verification=x", "v=spf1 include:spf.brevo.com ~all"],
        "brevo1._domainkey.garden.example": [`v=DKIM1; k=rsa; p=${"A".repeat(300)}`],
        "_dmarc.garden.example": ["v=DMARC1; p=none"],
      }),
      now: () => T.getTime(),
    });
    expect(result.domain).toBe("garden.example");
    expect(result.checkedAt).toBe(T.getTime());
    expect(result.items.map((i) => [i.check, i.status])).toEqual([
      ["spf", "ok"],
      ["dkim", "ok"],
      ["dmarc", "ok"],
    ]);
  });

  test("missing records are warnings with plain steps; nothing is refused", async () => {
    const result = byCheck(
      (await checkSenderDomain("hello@Garden.example", "google", { resolve: dns({}) })).items,
    );
    expect(result["spf"]).toMatchObject({
      status: "warn",
      message: "garden.example has no SPF record. Without it, your emails may land in spam.",
      steps: expect.stringContaining('"v=spf1 include:_spf.google.com ~all"'),
    });
    expect(result["dkim"]).toMatchObject({
      status: "warn",
      message: expect.stringContaining("google._domainkey.garden.example"),
    });
    expect(result["dmarc"]).toMatchObject({
      status: "warn",
      steps: expect.stringContaining('"v=DMARC1; p=none"'),
    });
  });

  test("two SPF records, or one that does not name the provider", async () => {
    const two = byCheck(
      (
        await checkSenderDomain("a@x.example", "other", {
          resolve: dns({ "x.example": ["v=spf1 include:a.example ~all", "v=spf1 -all"] }),
        })
      ).items,
    );
    expect(two["spf"]).toMatchObject({
      status: "warn",
      message:
        "x.example has 2 SPF records. A domain may have only one, so mail services ignore all of them.",
    });
    const other = byCheck(
      (
        await checkSenderDomain("a@x.example", "microsoft", {
          resolve: dns({ "x.example": ["v=spf1 include:_spf.google.com ~all"] }),
        })
      ).items,
    );
    expect(other["spf"]).toMatchObject({
      status: "warn",
      steps:
        "Add include:spf.protection.outlook.com to the SPF record, before the ~all or -all at its end.",
    });
  });

  test("a free mail sender through another provider is warned about; a lookup that fails is unknown, not wrong", async () => {
    const free = byCheck(
      (await checkSenderDomain("anna@gmail.com", "brevo", { resolve: dns({}) })).items,
    );
    expect(free["free-mail"]).toMatchObject({
      status: "warn",
      message: expect.stringContaining("gmail.com, a free mail service"),
    });
    const own = (await checkSenderDomain("anna@gmail.com", "google", { resolve: dns({}) })).items;
    expect(own.map((i) => i.check)).not.toContain("free-mail");
    const failing = byCheck(
      (
        await checkSenderDomain("a@x.example", "postmark", {
          resolve: dns({}, ["x.example", "_dmarc.x.example"]),
        })
      ).items,
    );
    expect(failing["spf"]!.status).toBe("unknown");
    expect(failing["dmarc"]!.status).toBe("unknown");
    // Postmark's DKIM names change, so it is not judged from here.
    expect(failing["dkim"]).toMatchObject({
      status: "unknown",
      message: expect.stringContaining("cannot be checked from here"),
    });
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the domain check and the email health`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    const secrets = new SiteSecrets("x".repeat(40));
    const accepting: MakeTransport = () => ({ send: async () => undefined });

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
    });
    afterEach(async () => db.close());

    const turnOn = () =>
      saveEmailSettings(
        db.runner,
        admin,
        siteId,
        secrets,
        {
          provider: "brevo",
          host: "smtp-relay.brevo.com",
          port: 587,
          security: "starttls",
          username: "u",
          password: "p",
          fromName: "Anna's Garden",
          fromAddress: "hello@garden.example",
          testTo: "anna@example.com",
        },
        { makeTransport: accepting },
      );

    test("the check runs only with email set up, is kept, and runs again once a day", async () => {
      const resolve = dns({ "garden.example": ["v=spf1 include:spf.brevo.com ~all"] });
      expect(await runDomainCheck(db.runner, siteId, { resolve })).toBeNull();
      await turnOn();
      let clock = T.getTime();
      const now = () => clock;
      expect(await runDailyDomainCheck(db.runner, siteId, { resolve, now })).toBe(true);
      expect(await loadDomainCheck(db.runner, siteId)).toMatchObject({
        domain: "garden.example",
        checkedAt: clock,
        items: [
          { check: "spf", status: "ok" },
          { check: "dkim", status: "warn" },
          { check: "dmarc", status: "warn" },
        ],
      });
      clock += 23 * 60 * 60 * 1000;
      expect(await runDailyDomainCheck(db.runner, siteId, { resolve, now })).toBe(false);
      clock += 2 * 60 * 60 * 1000;
      expect(await runDailyDomainCheck(db.runner, siteId, { resolve, now })).toBe(true);
    });

    test("three failed emails in a row, or one still failing after an hour, is a problem; administrators are told once a day (EM-09)", async () => {
      const log = async (status: string, minutesAgo: number, key = "invitation") =>
        db.run(
          `insert into email_log (id, site_id, email_key, to_address, subject, provider, status, attempts, created_at)
            values (?, ?, ?, 'b@example.com', 's', 'brevo', ?, 1, ?)`,
          [newId(), siteId, key, status, new Date(T.getTime() - minutesAgo * 60_000)],
        );
      const now = () => T.getTime();
      expect(await emailHealth(db.runner, siteId, now)).toEqual({ problem: null, message: "" });
      await log("failed", 30);
      await log("failed", 20);
      // A failed test email does not count.
      await log("failed", 15, "test");
      expect((await emailHealth(db.runner, siteId, now)).problem).toBeNull();
      await log("failed", 10);
      expect(await emailHealth(db.runner, siteId, now)).toMatchObject({ problem: "failing" });
      await log("sent", 5);
      expect((await emailHealth(db.runner, siteId, now)).problem).toBeNull();
      await log("retrying", 61);
      expect(await emailHealth(db.runner, siteId, now)).toMatchObject({ problem: "stuck" });

      const queued: string[] = [];
      const queue = async (to: string) => {
        queued.push(to);
        return true;
      };
      expect(await alertAdministrators(db.runner, siteId, queue, now)).toEqual([
        "anna@example.com",
      ]);
      expect(
        await alertAdministrators(db.runner, siteId, queue, () => T.getTime() + 60_000),
      ).toEqual([]);
      expect(
        await alertAdministrators(
          db.runner,
          siteId,
          queue,
          () => T.getTime() + 25 * 60 * 60 * 1000,
        ),
      ).toEqual(["anna@example.com"]);
    });
  });
}
