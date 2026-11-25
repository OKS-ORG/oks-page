// Client reports (spec 11, section 3), on SQLite and PostgreSQL, against a real HTTP server standing in for a client site: the
// report for 7, 30 or 90 days, what is left out when the site cannot say, the plain-text email, and that nothing a site says can
// put markup, new lines or an oversize value into a report.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addAgencySite,
  cleanReport,
  cleanStatus,
  listAgencySites,
  type AgencyContext,
} from "./agency.js";
import {
  connectionCode,
  connectorReport,
  connectorStatus,
  NonceStore,
  verifyRequest,
} from "./connector.js";
import type { Actor } from "./content.js";
import {
  EMAIL_JOB,
  emailJobHandler,
  saveEmailSettings,
  type MakeTransport,
  type OutgoingEmail,
} from "./email.js";
import { drainJobs } from "./jobs.js";
import {
  buildClientReport,
  emailClientReport,
  REPORT_EMAILS_PER_HOUR,
  reportText,
} from "./reports.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";

const SECRET = Buffer.alloc(32, 3).toString("base64url");
const actorFor = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (c) => caps.includes(c) };
};

describe("what a client site says is read as untrusted", () => {
  test("a status is cut to size, cleaned of control characters, and refused when it is not an answer", () => {
    expect(cleanStatus({ ok: false })).toBeNull();
    expect(cleanStatus("hello")).toBeNull();
    expect(cleanStatus(null)).toBeNull();
    const s = cleanStatus({
      ok: true,
      version: `1.2.3\n\u0000${"x".repeat(100)}`,
      siteName: "<b>Garden</b>",
      pendingUpdates: -4,
      lastBackupAt: "yesterday",
      diskFreeBytes: Number.POSITIVE_INFINITY,
      checks: [
        { id: "a", label: "Fine\r\nBcc: evil@example.com", ok: "yes" },
        ...Array.from({ length: 50 }, () => ({ id: "n", label: "n", ok: true })),
      ],
      at: 5,
    })!;
    expect(s.version).toHaveLength(40);
    for (const bad of ["\n", "\u0000"]) expect(s.version.includes(bad)).toBe(false);
    expect(s.siteName).toBe("<b>Garden</b>"); // text, shown as text (React escapes it; the email is plain text)
    expect(s).toMatchObject({
      pendingUpdates: null,
      lastBackupAt: null,
      diskFreeBytes: null,
      at: 5,
    });
    expect(s.checks).toHaveLength(20);
    expect(s.checks[0]).toEqual({ id: "a", label: "Fine  Bcc: evil@example.com", ok: false });
  });

  test("a report is bounded: days 1 to 90, whole non-negative counts, ten pages, valid days only", () => {
    expect(cleanReport({ ok: false })).toBeNull();
    const r = cleanReport({
      ok: true,
      days: 9999,
      views: -1,
      visitors: 2.7,
      publishedPages: "many",
      topPages: Array.from({ length: 40 }, (_, i) => ({ key: `/p${i}\n\nBcc: x`, count: i })),
      perDay: [
        { day: "2026-11-01", views: 5, visitors: 2 },
        { day: "<script>", views: 99, visitors: 99 },
        { day: "2026-11-02", views: "9", visitors: 1 },
      ],
    })!;
    expect(r).toMatchObject({ days: 90, views: 0, visitors: 2, publishedPages: 0 });
    expect(r.topPages).toHaveLength(10);
    expect(r.topPages[0]!.key).not.toMatch(/\n/);
    expect(r.perDay).toEqual([
      { day: "2026-11-01", views: 5, visitors: 2 },
      { day: "2026-11-02", views: 0, visitors: 1 },
    ]);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: client reports`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let eve: Actor;
    let server: Server;
    let base = "";
    let mode: "ok" | "no-status" | "hostile" = "ok";
    const asked: string[] = [];
    const secrets = new SiteSecrets("s".repeat(40));
    const nonces = new NonceStore();
    let sent: OutgoingEmail[] = [];
    const accepting: MakeTransport = () => ({
      send: async (email) => {
        sent.push(email);
      },
    });
    const ctx = (over: Partial<AgencyContext> = {}): AgencyContext => ({
      fetch: globalThis.fetch,
      now: Date.now,
      timeoutMs: 2000,
      agency: { active: true, limit: 5 },
      ...over,
    });
    const code = () => connectionCode(`${base}/s1`, "key-1", SECRET);
    const connect = async () => {
      const r = await addAgencySite(
        db.runner,
        anna,
        siteId,
        secrets,
        { code: code(), name: "Weber Garden" },
        ctx(),
      );
      if (!r.ok) throw new Error(r.message);
      asked.length = 0;
      return r.id;
    };

    beforeEach(async () => {
      db = await open();
      sent = [];
      mode = "ok";
      asked.length = 0;
      const setup = await runSetup(
        db.runner,
        async (input) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, input.name, input.email, new Date(), new Date()],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Agency",
          admin: { name: "Anna", email: "anna@agency.test", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      anna = actorFor(setup.userId, "administrator");
      eve = actorFor(setup.userId, "editor");
      const saved = await saveEmailSettings(
        db.runner,
        anna,
        siteId,
        secrets,
        {
          host: "smtp.example.com",
          port: 587,
          security: "starttls",
          username: "u",
          password: "p",
          fromName: "Anna's Agency",
          fromAddress: "hello@agency.example",
          testTo: "anna@agency.test",
        },
        { makeTransport: accepting },
      );
      expect(saved.ok).toBe(true);
      sent = [];
      // The client site: its own statistics, in the same database for the test.
      const day = new Date().toISOString().slice(0, 10);
      await db.run(
        `insert into stats_daily (site_id, day, kind, key, count) values (?, ?, 'views', '', 120)`,
        [siteId, day],
      );
      await db.run(
        `insert into stats_daily (site_id, day, kind, key, count) values (?, ?, 'visitors', '', 45)`,
        [siteId, day],
      );
      await db.run(
        `insert into stats_daily (site_id, day, kind, key, count) values (?, ?, 'page', '/about', 70)`,
        [siteId, day],
      );
      await db.run(
        `insert into stats_daily (site_id, day, kind, key, count) values (?, ?, 'page', '/', 50)`,
        [siteId, day],
      );
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
          const send = (status: number, body: unknown) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
          };
          const m = /^\/s1\/api\/oks\/v1\/([a-z]+)/.exec(req.url ?? "");
          if (!m) return send(404, { ok: false });
          const verified = verifyRequest({
            method: req.method ?? "GET",
            target: req.url ?? "",
            headers: (n) => (req.headers[n] as string | undefined) ?? null,
            body: Buffer.concat(chunks),
            keys: [{ id: "key-1", secret: SECRET }],
            nonces,
            now: Date.now(),
          });
          if (!verified.ok)
            return send(verified.status, {
              ok: false,
              code: verified.code,
              message: verified.message,
            });
          asked.push(req.url ?? "");
          if (mode === "hostile")
            return send(200, {
              ok: true,
              days: 7,
              views: 1,
              visitors: 1,
              publishedPages: 1,
              version: "<img src=x onerror=alert(1)>\n",
              siteName: "Evil\r\nBcc: attacker@example.com",
              checks: [{ id: "x", label: "<b>ok</b>\nInjected: yes", ok: true }],
              topPages: [{ key: "/x\r\n\r\nBcc: attacker@example.com", count: 3 }],
              perDay: [{ day: "2026-11-20", views: 1, visitors: 1 }],
            });
          if (m[1] === "status") {
            if (mode === "no-status") return send(500, { ok: false, message: "The site broke." });
            return send(200, {
              ok: true,
              ...(await connectorStatus(
                db.runner,
                siteId,
                {
                  version: "1.4.0",
                  twoFactor: { on: 1, total: 1 },
                  emailWorks: true,
                  privacyPage: false,
                  diskFreeBytes: 1e9,
                },
                Date.now(),
              )),
            });
          }
          const days = Number(new URL(req.url ?? "", "http://x").searchParams.get("days") ?? "30");
          return send(200, {
            ok: true,
            ...(await connectorReport(db.runner, siteId, Date.now(), days)),
          });
        });
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await db.close();
    });

    const deliver = () =>
      drainJobs(db.runner, {
        [EMAIL_JOB]: emailJobHandler(db.runner, secrets, { makeTransport: accepting }),
      });

    describe("the report", () => {
      test("it holds the counts, the pages read, the state of the site and who made it", async () => {
        const id = await connect();
        const r = await buildClientReport(
          db.runner,
          anna,
          siteId,
          secrets,
          id,
          30,
          ctx(),
          "Anna's Agency",
        );
        if (!r.ok) throw new Error(r.message);
        expect(r.report).toMatchObject({
          siteName: "Anna's Agency",
          siteUrl: `${base}/s1`,
          days: 30,
          views: 120,
          visitors: 45,
          preparedBy: "Anna's Agency",
        });
        expect(r.report.perDay).toHaveLength(30);
        expect(r.report.from < r.report.to).toBe(true);
        expect(r.report.to).toBe(new Date().toISOString().slice(0, 10));
        expect(r.report.topPages).toEqual([
          { key: "/about", count: 70 },
          { key: "/", count: 50 },
        ]);
        expect(r.report.health?.version).toBe("1.4.0");
        expect(r.report.health?.checks.map((c) => [c.label, c.ok])).toContainEqual([
          "Email is set up",
          true,
        ]);
      });

      test("a report covers 7, 30 or 90 days, and the site is asked for exactly that", async () => {
        const id = await connect();
        for (const days of [7, 90]) {
          const r = await buildClientReport(db.runner, anna, siteId, secrets, id, days, ctx(), "A");
          expect(r.ok && r.report.perDay.length).toBe(days);
          expect(asked.some((a) => a.includes(`/report?days=${days}`))).toBe(true);
        }
        for (const bad of [0, 15, 365, Number.NaN])
          expect(
            await buildClientReport(db.runner, anna, siteId, secrets, id, bad, ctx(), "A"),
          ).toMatchObject({
            ok: false,
            code: "invalid",
            message: "A report covers 7, 30 or 90 days.",
          });
      });

      test("when the site cannot say how it is, the report is made without that part", async () => {
        const id = await connect();
        mode = "no-status";
        const r = await buildClientReport(db.runner, anna, siteId, secrets, id, 30, ctx(), "A");
        expect(r.ok && r.report.health).toBeNull();
        expect(r.ok && r.report.views).toBe(120);
      });

      test("it needs an Agency key and a person who manages the site; a site not connected is not found", async () => {
        const id = await connect();
        expect(
          await buildClientReport(
            db.runner,
            anna,
            siteId,
            secrets,
            id,
            30,
            ctx({ agency: { active: false, limit: 0 } }),
            "A",
          ),
        ).toMatchObject({
          ok: false,
          code: "forbidden",
          message: expect.stringMatching(/Agency key/),
        });
        expect(
          await buildClientReport(db.runner, eve, siteId, secrets, id, 30, ctx(), "A"),
        ).toMatchObject({ ok: false, code: "forbidden" });
        expect(
          await buildClientReport(db.runner, anna, siteId, secrets, newId(), 30, ctx(), "A"),
        ).toMatchObject({ ok: false, code: "not_found" });
        // A site that is down gives the plain words of the dashboard.
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
        expect(
          await buildClientReport(
            db.runner,
            anna,
            siteId,
            secrets,
            id,
            30,
            ctx({ timeoutMs: 400 }),
            "A",
          ),
        ).toMatchObject({ ok: false, message: expect.stringMatching(/could not be reached/) });
        server = createServer();
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      });

      test("nothing a site says can put markup or new lines into the report or its text", async () => {
        const id = await connect();
        mode = "hostile";
        const r = await buildClientReport(
          db.runner,
          anna,
          siteId,
          secrets,
          id,
          7,
          ctx(),
          "Anna\nBcc: x",
        );
        if (!r.ok) throw new Error(r.message);
        const text = reportText(r.report);
        // Every line is a line we wrote: a hostile value cannot start one of its own.
        expect(text.split("\n").filter((l) => /^\s*Bcc:/i.test(l))).toEqual([]);
        expect(text).not.toMatch(/\r/);
        expect(text.split("\n").some((l) => l.startsWith("Injected"))).toBe(false);
        expect(r.report.preparedBy).toBe("Anna Bcc: x");
        expect(text).not.toContain(SECRET);
      });
    });

    describe("the email", () => {
      test("it goes from this site's own email, as plain text with the numbers, and says who made it", async () => {
        const id = await connect();
        const done = await emailClientReport(
          db.runner,
          anna,
          siteId,
          secrets,
          {
            id,
            days: 30,
            to: "Carla@Weber.example",
            note: "Thank you for a good month.\nSee you in December.",
          },
          ctx(),
          "Anna's Agency",
        );
        expect(done).toEqual({ ok: true });
        await deliver();
        expect(sent).toHaveLength(1);
        const mail = sent[0]!;
        expect(mail.to).toBe("Carla@Weber.example");
        expect(mail.subject).toMatch(
          /^Report for Anna's Agency: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/,
        );
        expect(mail.text).toContain("Page views: 120");
        expect(mail.text).toContain("Visitors: 45");
        expect(mail.text).toContain("1. /about: 70");
        expect(mail.text).toContain("Thank you for a good month.\nSee you in December.");
        expect(mail.text).toContain("Fine: Email is set up");
        expect(mail.text).toContain("Needs a look: A privacy page is chosen");
        expect(mail.text.trim().endsWith("Anna's Agency")).toBe(true);
        expect(mail.text).not.toContain(SECRET);
        expect(mail.text).not.toContain("key-1");
      });

      test("the address must be an address, the note not too long, and only an agency person sends", async () => {
        const id = await connect();
        for (const to of [
          "",
          "nobody",
          "a@b",
          "a b@c.example",
          "x@y.example,z@y.example",
          undefined,
          42,
        ])
          expect(
            await emailClientReport(
              db.runner,
              anna,
              siteId,
              secrets,
              { id, days: 30, to },
              ctx(),
              "A",
            ),
          ).toMatchObject({
            ok: false,
            code: "invalid",
            message: "Write the client's email address.",
          });
        expect(
          await emailClientReport(
            db.runner,
            anna,
            siteId,
            secrets,
            { id, days: 30, to: "c@w.example", note: "x".repeat(1001) },
            ctx(),
            "A",
          ),
        ).toMatchObject({ ok: false, code: "invalid" });
        expect(
          await emailClientReport(
            db.runner,
            eve,
            siteId,
            secrets,
            { id, days: 30, to: "c@w.example" },
            ctx(),
            "A",
          ),
        ).toMatchObject({ ok: false, code: "forbidden" });
        expect(
          await emailClientReport(
            db.runner,
            anna,
            siteId,
            secrets,
            { id, days: 30, to: "c@w.example" },
            ctx({ agency: { active: false, limit: 0 } }),
            "A",
          ),
        ).toMatchObject({ ok: false, code: "forbidden" });
        await deliver();
        expect(sent).toHaveLength(0);
      });

      test("at most three to one address in an hour", async () => {
        const id = await connect();
        for (let i = 0; i < REPORT_EMAILS_PER_HOUR; i++)
          expect(
            (
              await emailClientReport(
                db.runner,
                anna,
                siteId,
                secrets,
                { id, days: 7, to: "c@w.example" },
                ctx(),
                "A",
              )
            ).ok,
          ).toBe(true);
        expect(
          await emailClientReport(
            db.runner,
            anna,
            siteId,
            secrets,
            { id, days: 7, to: "C@W.example" },
            ctx(),
            "A",
          ),
        ).toMatchObject({ ok: false, message: expect.stringMatching(/Three reports/) });
        expect(
          (
            await emailClientReport(
              db.runner,
              anna,
              siteId,
              secrets,
              { id, days: 7, to: "other@w.example" },
              ctx(),
              "A",
            )
          ).ok,
        ).toBe(true);
      });

      test("while email is not set up it says so and sends nothing", async () => {
        const id = await connect();
        await db.run(`delete from settings where key = 'email'`);
        expect(
          await emailClientReport(
            db.runner,
            anna,
            siteId,
            secrets,
            { id, days: 30, to: "c@w.example" },
            ctx(),
            "A",
          ),
        ).toMatchObject({
          ok: false,
          code: "invalid",
          message: expect.stringMatching(/Email is not set up/),
        });
        expect((await listAgencySites(db.runner, anna, siteId)).length).toBe(1);
      });
    });
  });
}
