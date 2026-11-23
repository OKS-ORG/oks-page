// Requests from visitors to see or delete their data (spec 18, section 5; PR-06): the confirmation link, what is kept and what
// is not, repeated asks, expiry, who is told, how the owner sees and answers a request, and what is forgotten. In SQLite and
// PostgreSQL. The email queue is a stand-in that records what would be sent.
import { SiteSecrets, type Actor } from "@oks-page/core";
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { emailHash } from "./privacy-requests";
import {
  ANSWER_DAYS,
  ANSWERED_KEEP_DAYS,
  answerPrivacyRequest,
  confirmPrivacyRequest,
  createPrivacyRequest,
  LINK_DAYS,
  listPrivacyRequests,
  purgePrivacyRequests,
  REMIND_DAYS,
  sendPrivacyReminders,
} from "./privacy-visitor";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000151";
const USER = "USER0000000000000000000151";
const ROLE = "ROLE0000000000000000000151";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const secrets = new SiteSecrets("s".repeat(40));
const admin: Actor = { userId: USER, can: (c) => c === "settings.manage" };
const nobody: Actor = { userId: USER, can: () => false };

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: privacy requests from visitors`, () => {
    let db: TestDb;
    let clock = 1_800_000_000_000;
    let mails: { to: string; subject: string; text: string; expiresAt?: number }[] = [];
    let canSend = true;

    const create = (email: unknown, what: unknown = "export") =>
      createPrivacyRequest(
        db.runner,
        SITE,
        { email, kind: what },
        {
          secrets,
          origin: "https://garden.example/",
          siteName: "Anna's Garden",
          now: () => clock,
          queue: async (to, subject, text, expiresAt) => {
            if (!canSend) return false;
            mails.push({ to, subject, text, expiresAt });
            return true;
          },
        },
      );
    const tokenOf = (n = 0) =>
      /\/privacy-request\/confirm\/([A-Za-z0-9_-]+)/.exec(mails[n]!.text)![1]!;
    const confirm = (token: string) =>
      confirmPrivacyRequest(db.runner, token, {
        origin: "https://garden.example",
        now: () => clock,
        notify: async (_site, to, subject, text) => {
          mails.push({ to, subject, text });
          return true;
        },
      });
    const rows = () =>
      db.runner.all(
        `select "status", "kind", "email_sealed", "token_hash" from "privacy_requests" order by "created_at", "id"`,
      );

    beforeEach(async () => {
      db = await open();
      clock = 1_800_000_000_000;
      mails = [];
      canSend = true;
      await db.run(
        "insert into sites (id, name, created_at, updated_at) values (?, 'Anna''s Garden', ?, ?)",
        [SITE, T, T],
      );
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, 'Anna', 'anna@garden.example', ?, ?)",
        [USER, T, T],
      );
      await db.run(
        "insert into roles (id, site_id, key, label, is_system, created_at) values (?, ?, 'administrator', 'Administrator', ?, ?)",
        [ROLE, SITE, true, T],
      );
      await db.run(
        "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
        [SITE, USER, ROLE, T],
      );
    });

    test("a request sends the address a link, and the site keeps only a hash of the link and a sealed address", async () => {
      expect(await create("  Mia@Example.com ", "delete")).toEqual({ ok: true });
      expect(mails.length).toBe(1);
      expect(mails[0]).toMatchObject({
        to: "mia@example.com",
        subject: "Please confirm your request: Anna's Garden",
      });
      expect(mails[0]!.text).toContain("delete the personal data");
      expect(mails[0]!.text).toContain("https://garden.example/privacy-request/confirm/");
      expect(mails[0]!.expiresAt).toBe(clock + LINK_DAYS * DAY);
      const stored = await rows();
      expect(stored.map((r) => [r["status"], r["kind"]])).toEqual([["pending", "delete"]]);
      // Neither the address nor the link is in the database in plain form.
      const everything = JSON.stringify(await db.runner.all(`select * from "privacy_requests"`));
      expect(everything).not.toContain("mia@example.com");
      expect(everything).not.toContain(tokenOf());
      expect(String(stored[0]!["email_sealed"])).toMatch(/^v1:/);
      // The audit log says it happened, without the address.
      const log = await db.runner.all(
        `select "action", "target_id", "detail" from audit_log where site_id = ?`,
        [SITE],
      );
      expect(log.map((l) => [l["action"], l["target_id"]])).toEqual([
        ["privacy.request", emailHash("mia@example.com")],
      ]);
      expect(JSON.stringify(log)).not.toContain("mia@");
    });

    test("an address asked about in the last hour gets no second email; after an hour it does", async () => {
      await create("mia@example.com");
      expect(await create("MIA@example.com", "delete")).toEqual({ ok: true });
      expect(mails.length).toBe(1);
      expect((await rows()).length).toBe(1);
      clock += HOUR + 1000;
      await create("mia@example.com");
      expect(mails.length).toBe(2);
      expect((await rows()).length).toBe(2);
    });

    test("a bad address or choice is refused, and a site that cannot send email keeps nothing", async () => {
      for (const [email, what] of [
        ["nope", "export"],
        ["", "export"],
        [null, "export"],
        ["mia@example.com", "sell"],
        ["mia@example.com", null],
      ] as const) {
        const r = await create(email, what);
        expect(!r.ok && r.code).toBe("invalid");
      }
      canSend = false;
      const r = await create("mia@example.com");
      expect(!r.ok && r.code).toBe("unavailable");
      expect(await rows()).toEqual([]);
      expect(mails).toEqual([]);
      expect(await db.runner.all(`select 1 from audit_log`)).toEqual([]);
    });

    test("opening the link confirms the request once, and the administrators are told once", async () => {
      await create("mia@example.com", "export");
      const token = tokenOf();
      const first = await confirm(token);
      expect(first).toEqual({ ok: true, kind: "export", already: false });
      expect((await rows())[0]!["status"]).toBe("confirmed");
      expect(mails.slice(1).map((m) => [m.to, m.subject])).toEqual([
        ["anna@garden.example", "A privacy request was confirmed"],
      ]);
      expect(mails[1]!.text).toContain("send a copy of");
      expect(mails[1]!.text).toContain("30 days");
      expect(mails[1]!.text).toContain("https://garden.example/admin/tools/privacy");
      expect(mails[1]!.text).not.toContain("mia@");
      // Again: it stays as it is, and nobody is told twice.
      expect(await confirm(token)).toEqual({ ok: true, kind: "export", already: true });
      expect(mails.length).toBe(2);
      const log = await db.runner.all(
        `select "action", "actor_type" from audit_log where site_id = ? order by created_at, id`,
        [SITE],
      );
      expect(log.map((l) => [l["action"], l["actor_type"]])).toEqual([
        ["privacy.request", "system"],
        ["privacy.request_confirmed", "system"],
      ]);
    });

    test("a wrong, short or expired link confirms nothing", async () => {
      await create("mia@example.com");
      const token = tokenOf();
      for (const bad of [
        "",
        "short",
        token + "x",
        token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"),
        "x".repeat(300),
      ])
        expect(await confirm(bad)).toEqual({ ok: false });
      clock += LINK_DAYS * DAY + 1000;
      expect(await confirm(token)).toEqual({ ok: false });
      expect((await rows())[0]!["status"]).toBe("pending");
      expect(mails.length).toBe(1);
    });

    test("the owner sees confirmed requests with the address and the day the answer is due, and answers them", async () => {
      await create("mia@example.com", "export");
      await create("zed@example.com", "delete");
      await confirm(tokenOf(0));
      clock += DAY;
      const list = await listPrivacyRequests(db.runner, admin, SITE, secrets, () => clock);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      // Only the confirmed one is listed; the other is counted as waiting for its person.
      expect(list.open.map((r) => [r.kind, r.email])).toEqual([["export", "mia@example.com"]]);
      expect(list.open[0]!.dueAt - list.open[0]!.confirmedAt).toBe(ANSWER_DAYS * DAY);
      expect([list.waiting, list.answered]).toEqual([1, 0]);
      const denied = await listPrivacyRequests(db.runner, nobody, SITE, secrets);
      expect(!denied.ok && denied.code).toBe("forbidden");
      // Another secret cannot read the address.
      const wrong = await listPrivacyRequests(
        db.runner,
        admin,
        SITE,
        new SiteSecrets("x".repeat(40)),
        () => clock,
      );
      expect(wrong.ok && wrong.open[0]!.email).toBeNull();

      const id = list.open[0]!.id;
      expect((await answerPrivacyRequest(db.runner, nobody, SITE, id)).ok).toBe(false);
      expect(await answerPrivacyRequest(db.runner, admin, SITE, id, () => clock)).toEqual({
        ok: true,
      });
      // The address is wiped; the request stays as a record.
      const after = (await rows()).find((r) => r["status"] === "answered")!;
      expect(after["email_sealed"]).toBeNull();
      const again = await answerPrivacyRequest(db.runner, admin, SITE, id);
      expect(!again.ok && again.code).toBe("not_found");
      const pending = await db.runner.all(
        `select "id" from privacy_requests where status = 'pending'`,
      );
      const notYet = await answerPrivacyRequest(db.runner, admin, SITE, String(pending[0]!["id"]));
      expect(!notYet.ok && notYet.code).toBe("not_found");
      const done = await listPrivacyRequests(db.runner, admin, SITE, secrets, () => clock);
      expect(done.ok && [done.open.length, done.answered]).toEqual([0, 1]);
      const log = await db.runner.all(
        `select "action", "actor_type" from audit_log where "action" = 'privacy.request_answered'`,
      );
      expect(log.map((l) => l["actor_type"])).toEqual(["user"]);
    });

    test("requests whose link ran out are forgotten, and answered ones after a year; a confirmed one never", async () => {
      await create("a@example.com");
      clock += 2 * HOUR;
      await create("b@example.com");
      clock += 2 * HOUR;
      await create("c@example.com");
      clock += 2 * HOUR;
      await create("d@example.com");
      await confirm(tokenOf(2));
      await confirm(tokenOf(3));
      const open = await listPrivacyRequests(db.runner, admin, SITE, secrets, () => clock);
      if (!open.ok) throw new Error("no list");
      await answerPrivacyRequest(db.runner, admin, SITE, open.open[0]!.id, () => clock);
      // After the links ran out: the two that were never opened go; the confirmed and the answered one stay.
      clock += LINK_DAYS * DAY;
      expect(await purgePrivacyRequests(db.runner, () => clock)).toBe(2);
      expect((await rows()).map((r) => r["status"]).sort()).toEqual(["answered", "confirmed"]);
      // A year after it was answered, the record goes too.
      clock += ANSWERED_KEEP_DAYS * DAY;
      expect(await purgePrivacyRequests(db.runner, () => clock)).toBe(1);
      expect((await rows()).map((r) => r["status"])).toEqual(["confirmed"]);
    });

    // ---- reminders: the administrators are told when the 30 days are nearly up, and when they are
    const remind = (options: { origin?: string; send?: boolean } = {}) =>
      sendPrivacyReminders(db.runner, {
        origin: options.origin,
        now: () => clock,
        queue: async (_site, to, subject, text) => {
          if (options.send === false) return false;
          mails.push({ to, subject, text });
          return true;
        },
      });
    const confirmed = async (email: string) => {
      const before = mails.length;
      await create(email, "export");
      await confirm(tokenOf(before));
    };
    const stages = async () =>
      (
        await db.runner.all(
          `select "reminder_stage" as "s" from "privacy_requests" order by "created_at", "id"`,
        )
      ).map((r) => Number(r["s"]));

    test("a confirmed request gets one reminder when 7 days are left and one when it is overdue, and no more", async () => {
      await confirmed("mia@example.com");
      const start = clock;
      const at = (days: number) => {
        clock = start + days * DAY;
      };
      const before = mails.length;
      at(ANSWER_DAYS - REMIND_DAYS - 1);
      expect(await remind()).toEqual({ soon: 0, overdue: 0 });
      expect(mails.length).toBe(before);
      // Seven days before it is due: one email to the administrator, naming how many and never who.
      at(ANSWER_DAYS - REMIND_DAYS);
      expect(await remind({ origin: "https://garden.example/" })).toEqual({ soon: 1, overdue: 0 });
      expect(mails.slice(before).map((m) => [m.to, m.subject])).toEqual([
        ["anna@garden.example", "A privacy request is due soon"],
      ]);
      expect(mails[before]!.text).toContain("within 7 days");
      expect(mails[before]!.text).toContain("https://garden.example/admin/tools/privacy");
      expect(mails[before]!.text).not.toContain("mia@");
      expect(await stages()).toEqual([1]);
      // Again, and a day later: nothing more.
      expect(await remind()).toEqual({ soon: 0, overdue: 0 });
      at(ANSWER_DAYS - 1);
      expect(await remind()).toEqual({ soon: 0, overdue: 0 });
      expect(mails.length).toBe(before + 1);
      // When the day has come: one email that it is overdue, and the owner's list says so.
      at(ANSWER_DAYS);
      expect(await remind()).toEqual({ soon: 0, overdue: 1 });
      expect(mails[before + 1]).toMatchObject({
        to: "anna@garden.example",
        subject: "A privacy request is overdue",
      });
      expect(mails[before + 1]!.text).toContain("past the 30 days");
      expect(mails[before + 1]!.text).toContain("Open Tools > Privacy requests in your admin.");
      expect(await stages()).toEqual([2]);
      at(ANSWER_DAYS + 20);
      expect(await remind()).toEqual({ soon: 0, overdue: 0 });
      expect(mails.length).toBe(before + 2);
      const list = await listPrivacyRequests(db.runner, admin, SITE, secrets, () => clock);
      expect(list.ok && list.open.map((r) => r.overdue)).toEqual([true]);
      const log = await db.runner.all(
        `select "action", "detail", "target_id" from audit_log where "action" = 'privacy.request_reminder' order by created_at, id`,
      );
      expect(log.length).toBe(2);
      expect(JSON.stringify(log)).not.toContain("mia@");
    });

    test("several requests are in one email, and a request that is already overdue gets only the overdue email", async () => {
      await confirmed("a@example.com");
      clock += HOUR * 2;
      await confirmed("b@example.com");
      const start = clock;
      const before = mails.length;
      clock = start + (ANSWER_DAYS - REMIND_DAYS + 1) * DAY;
      expect(await remind()).toEqual({ soon: 2, overdue: 0 });
      expect(mails.slice(before).map((m) => m.subject)).toEqual(["A privacy request is due soon"]);
      expect(mails[before]!.text).toContain("2 confirmed privacy requests");
      // A third one that nobody looked at for a long time (the server was off): only the overdue email.
      await confirmed("c@example.com");
      clock += (ANSWER_DAYS + 3) * DAY;
      const second = mails.length;
      expect(await remind()).toEqual({ soon: 0, overdue: 3 });
      expect(mails.slice(second).map((m) => m.subject)).toEqual(["A privacy request is overdue"]);
      expect(mails[second]!.text).toContain("3 confirmed privacy requests");
      expect(await stages()).toEqual([2, 2, 2]);
    });

    test("a site that cannot send email is tried again at the next run, and nothing is lost", async () => {
      await confirmed("mia@example.com");
      clock += (ANSWER_DAYS - REMIND_DAYS) * DAY;
      const before = mails.length;
      expect(await remind({ send: false })).toEqual({ soon: 0, overdue: 0 });
      expect(await stages()).toEqual([0]);
      expect(mails.length).toBe(before);
      clock += DAY;
      expect(await remind()).toEqual({ soon: 1, overdue: 0 });
      expect(await stages()).toEqual([1]);
    });

    test("a request nobody confirmed, one that was answered, and a site without administrators get no reminder", async () => {
      await create("pending@example.com");
      await confirmed("done@example.com");
      const list = await listPrivacyRequests(db.runner, admin, SITE, secrets, () => clock);
      if (!list.ok) throw new Error("no list");
      await answerPrivacyRequest(db.runner, admin, SITE, list.open[0]!.id, () => clock);
      clock += (ANSWER_DAYS + 1) * DAY;
      const before = mails.length;
      expect(await remind()).toEqual({ soon: 0, overdue: 0 });
      expect(mails.length).toBe(before);
      // A confirmed request on a site where nobody is an administrator: nothing can be sent, and it is not counted as sent.
      await db.run(`delete from site_members where site_id = ?`, [SITE]);
      clock += DAY;
      await confirmed("late@example.com");
      clock += (ANSWER_DAYS + 1) * DAY;
      expect(await remind()).toEqual({ soon: 0, overdue: 0 });
      expect(await stages()).toEqual([0, 0, 0]);
    });
  });
}
