// AU-38 (the per-account sign-in limit), AU-39 (behind a proxy) and AU-43 (recovery), on SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authFor, cookieOf, post } from "./testing.js";
import type { OksAuth } from "./create-auth.js";

const GOOD = "victim good password";
const MIN = 60_000;

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: sign-in limits`, () => {
    let db: TestDb;
    let a: OksAuth;
    let now: number;
    beforeEach(async () => {
      db = await open();
      now = Date.now();
      a = authFor(db, { clock: () => now, trustedProxies: ["10.0.0.0/8"] });
      await a.auth.api.signUpEmail({
        body: { email: "victim@example.com", password: GOOD, name: "V" },
      });
    });
    afterEach(async () => db.close());

    // Direct calls skip the address limit (it lives in the HTTP handler) but not the account limit.
    const guess = async (email: string, password: string, ip: string) => {
      try {
        return (
          await a.auth.api.signInEmail({
            body: { email, password },
            asResponse: true,
            headers: { "x-oks-client-ip": ip },
          })
        ).status;
      } catch (e) {
        // A refusal made by our own check is thrown as an error, not returned.
        return (e as { statusCode?: number }).statusCode ?? 500;
      }
    };

    test("AU-38 40 guesses from 40 addresses: only the first 5 are checked, the rest get 429", async () => {
      const codes: number[] = [];
      for (let i = 0; i < 40; i++)
        codes.push(await guess("victim@example.com", `guess ${i}`, `198.51.100.${i + 1}`));
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    });

    test("AU-38 50 guesses started at the same moment: still only 5 are checked", async () => {
      const codes = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          guess("victim@example.com", `parallel ${i}`, `198.51.100.${i + 1}`),
        ),
      );
      expect(codes.filter((c) => c === 401)).toHaveLength(5);
      expect(codes.filter((c) => c === 429)).toHaveLength(45);
    });

    test("AU-38 the cool-down also refuses the owner's right password (the known trade-off)", async () => {
      for (let i = 0; i < 5; i++) await guess("victim@example.com", `guess ${i}`, "198.51.100.1");
      expect(await guess("victim@example.com", GOOD, "203.0.113.5")).toBe(429);
    });

    test("AU-38 after the cool-down the owner can sign in, and the count is cleared", async () => {
      for (let i = 0; i < 5; i++) await guess("victim@example.com", `guess ${i}`, "198.51.100.1");
      now += MIN + 1000;
      expect(await guess("victim@example.com", GOOD, "203.0.113.5")).toBe(200);
      expect(await a.limiter.status("victim@example.com")).toEqual({ count: 0, retryAfterMs: 0 });
    });

    test("AU-38 each further wrong try doubles the wait, up to one hour", async () => {
      for (let i = 0; i < 5; i++) await guess("victim@example.com", `guess ${i}`, "198.51.100.1");
      const waits: number[] = [];
      for (let round = 0; round < 9; round++) {
        const { retryAfterMs } = await a.limiter.status("victim@example.com");
        waits.push(retryAfterMs / 1000);
        now += retryAfterMs + 1;
        expect(await guess("victim@example.com", `again ${round}`, "198.51.100.1")).toBe(401);
      }
      expect(waits).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600, 3600]);
    });

    test("AU-38 an administrator can clear the limit", async () => {
      for (let i = 0; i < 6; i++) await guess("victim@example.com", `guess ${i}`, "198.51.100.1");
      expect(await guess("victim@example.com", GOOD, "203.0.113.5")).toBe(429);
      expect(await a.limiter.clear("Victim@Example.com")).toBe(true);
      expect(await guess("victim@example.com", GOOD, "203.0.113.5")).toBe(200);
      expect(await a.limiter.clear("victim@example.com")).toBe(false);
    });

    test("AU-38 the count starts again after 15 minutes without a try", async () => {
      for (let i = 0; i < 3; i++) await guess("victim@example.com", `guess ${i}`, "198.51.100.1");
      now += 16 * MIN;
      for (let i = 0; i < 4; i++)
        expect(await guess("victim@example.com", `late ${i}`, "198.51.100.1")).toBe(401);
    });

    test("AU-38 another account is not affected, and the email is not case sensitive", async () => {
      for (let i = 0; i < 5; i++) await guess("VICTIM@Example.com", `guess ${i}`, "198.51.100.1");
      expect(await guess("victim@example.com", GOOD, "198.51.100.2")).toBe(429);
      expect(await guess("someone-else@example.com", "whatever pass 1", "198.51.100.3")).toBe(401);
    });

    test("AU-38 the limit also holds through the HTTP route", async () => {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++)
        codes.push(
          (
            await post(
              a,
              "/sign-in/email",
              { email: "victim@example.com", password: `guess ${i}` },
              {},
              `203.0.113.${i + 10}`,
            )
          ).status,
        );
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    });

    test("AU-39 behind a trusted proxy, a made-up X-Forwarded-For does not get around the address limit", async () => {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) {
        // The real client is 198.51.100.4. Each request claims a different address on the left.
        codes.push(
          (
            await post(
              a,
              "/sign-in/email",
              { email: `n${i}@example.com`, password: "wrong password" },
              { "x-forwarded-for": `1.1.1.${i}, 198.51.100.4` },
              "10.0.0.2",
            )
          ).status,
        );
      }
      expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
      expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    });

    test("AU-39 two different real clients behind the proxy are limited separately", async () => {
      for (let i = 0; i < 6; i++)
        await post(
          a,
          "/sign-in/email",
          { email: `n${i}@example.com`, password: "wrong password" },
          { "x-forwarded-for": "198.51.100.4" },
          "10.0.0.2",
        );
      const other = await post(
        a,
        "/sign-in/email",
        { email: "n9@example.com", password: "wrong password" },
        { "x-forwarded-for": "198.51.100.5" },
        "10.0.0.2",
      );
      expect(other.status).toBe(401);
    });

    test("AU-39 without a trusted proxy, the header is ignored and the connection address is limited", async () => {
      const plain = authFor(db, { clock: () => now });
      const codes: number[] = [];
      for (let i = 0; i < 8; i++)
        codes.push(
          (
            await post(
              plain,
              "/sign-in/email",
              { email: `m${i}@example.com`, password: "wrong password" },
              { "x-forwarded-for": `9.9.9.${i}` },
              "203.0.113.50",
            )
          ).status,
        );
      expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    });

    test("AU-43 the recovery command: wrong secret changes nothing; the right one resets the password, signs everything out and is logged", async () => {
      const site = "SITE0000000000000000000001";
      const user = String(
        (await db.run("select id from users where email = 'victim@example.com'"))[0]!["id"],
      );
      const role = "ROLE0000000000000000000001";
      const t = new Date(1_700_000_000_000);
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        site,
        t,
        t,
      ]);
      await db.run(
        "insert into roles (id, site_id, key, label, created_at) values (?, ?, 'administrator', 'Administrator', ?)",
        [role, site, t],
      );
      await db.run(
        "insert into site_members (site_id, user_id, role_id, created_at) values (?, ?, ?, ?)",
        [site, user, role, t],
      );
      const session = cookieOf(
        await a.auth.api.signInEmail({
          body: { email: "victim@example.com", password: GOOD },
          asResponse: true,
          headers: { "x-oks-client-ip": "203.0.113.60" },
        }),
      );
      for (let i = 0; i < 5; i++) await guess("victim@example.com", `guess ${i}`, "198.51.100.1");

      await expect(
        a.recover({
          secret: "x".repeat(40),
          email: "victim@example.com",
          newPassword: "a fresh good password",
        }),
      ).rejects.toThrow(/secret key is wrong/);
      await expect(
        a.recover({ secret: "s".repeat(40), email: "victim@example.com", newPassword: "short" }),
      ).rejects.toThrow(/at least 10/);
      await expect(
        a.recover({
          secret: "s".repeat(40),
          email: "nobody@example.com",
          newPassword: "a fresh good password",
        }),
      ).rejects.toThrow(/no account/);
      expect(Number((await db.run("select count(*) as c from audit_log"))[0]!["c"])).toBe(0);

      const result = await a.recover({
        secret: "s".repeat(40),
        email: "Victim@Example.com",
        newPassword: "a fresh good password",
      });
      expect(result.auditEntries).toBe(1);
      expect(result.sessionsRemoved).toBeGreaterThanOrEqual(1);
      expect(await a.auth.api.getSession({ headers: new Headers({ cookie: session }) })).toBeNull();
      expect(await guess("victim@example.com", GOOD, "203.0.113.61")).toBe(401);
      expect(await guess("victim@example.com", "a fresh good password", "203.0.113.62")).toBe(200);
      const audit = (await db.run("select action, actor_type, target_id from audit_log"))[0]!;
      expect(audit).toEqual({
        action: "user.password_reset",
        actor_type: "system",
        target_id: user,
      });
    });
  });
}
