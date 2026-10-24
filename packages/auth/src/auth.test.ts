// Spec 02 acceptance tests AU-01 to AU-11 (and AU-50: the same on PostgreSQL), AU-38, AU-39, AU-42 and AU-45,
// on SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { generateSync } from "otplib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authFor, cookieOf, post } from "./testing.js";
import type { OksAuth } from "./create-auth.js";

const PASSWORD = "correct horse battery";

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: sign-in`, () => {
    let db: TestDb;
    let a: OksAuth;
    beforeEach(async () => {
      db = await open();
      a = authFor(db);
    });
    afterEach(async () => db.close());

    const signUp = (email = "anna@example.com", ip = "10.0.0.1") =>
      a.auth.api.signUpEmail({
        body: { email, password: PASSWORD, name: "Anna" },
        headers: { "x-oks-client-ip": ip },
      });
    const signIn = (password = PASSWORD, ip = "10.0.0.2", email = "anna@example.com") =>
      a.auth.api.signInEmail({
        body: { email, password },
        asResponse: true,
        headers: { "x-oks-client-ip": ip },
      });

    test("AU-01 sign-up creates a user with a 26-character ULID, through our own tables, with times in milliseconds", async () => {
      const result = await signUp();
      expect(result.user.email).toBe("anna@example.com");
      const row = (
        await db.run("select id, created_at from users where email = ?", ["anna@example.com"])
      )[0]!;
      expect(String(row["id"])).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      const created =
        row["created_at"] instanceof Date ? row["created_at"].getTime() : Number(row["created_at"]);
      expect(Math.abs(created - Date.now())).toBeLessThan(60_000);
    });

    test("AU-02 sign-in with the right password gives a session cookie; the session can be read", async () => {
      await signUp();
      const res = await signIn();
      expect(res.status).toBe(200);
      const session = await a.auth.api.getSession({
        headers: new Headers({ cookie: cookieOf(res) }),
      });
      expect(session?.user.email).toBe("anna@example.com");
    });

    test("AU-03 a wrong password is refused (401)", async () => {
      await signUp();
      expect((await signIn("not the password")).status).toBe(401);
    });

    test("AU-04 a password shorter than the minimum is refused", async () => {
      const res = await a.auth.api.signUpEmail({
        body: { email: "s@example.com", password: "short", name: "S" },
        asResponse: true,
        headers: { "x-oks-client-ip": "10.0.0.3" },
      });
      expect(res.status).toBe(400);
    });

    test("a second sign-up with the same email is refused, and 30 at once create one user", async () => {
      await signUp("dup@example.com");
      expect(
        (
          await a.auth.api.signUpEmail({
            body: { email: "dup@example.com", password: PASSWORD, name: "D" },
            asResponse: true,
            headers: { "x-oks-client-ip": "10.0.0.4" },
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      const codes = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          a.auth.api
            .signUpEmail({
              body: { email: "race@example.com", password: PASSWORD, name: `R${i}` },
              asResponse: true,
              headers: { "x-oks-client-ip": `10.1.0.${i + 1}` },
            })
            .then(
              (r: Response) => r.status,
              () => 500,
            ),
        ),
      );
      expect(codes.filter((c: number) => c === 200)).toHaveLength(1);
      expect(
        Number(
          (await db.run("select count(*) as c from users where email = 'race@example.com'"))[0]![
            "c"
          ],
        ),
      ).toBe(1);
    });

    test("AU-08 a user can list sessions and sign out all other devices", async () => {
      await signUp();
      const c2 = cookieOf(await signIn(PASSWORD, "10.0.0.5"));
      const before = await a.auth.api.listSessions({ headers: new Headers({ cookie: c2 }) });
      await a.auth.api.revokeOtherSessions({ headers: new Headers({ cookie: c2 }) });
      const after = await a.auth.api.listSessions({ headers: new Headers({ cookie: c2 }) });
      expect(before.length).toBeGreaterThanOrEqual(2);
      expect(after).toHaveLength(1);
    });

    describe("two-factor", () => {
      async function enrolled() {
        await signUp();
        const cookie = cookieOf(await signIn(PASSWORD, "10.0.0.6"));
        const enable = await a.auth.api.enableTwoFactor({
          body: { password: PASSWORD },
          headers: new Headers({ cookie }),
        });
        const secret = new URL(enable.totpURI).searchParams.get("secret")!;
        const verified = await a.auth.api.verifyTOTP({
          body: { code: generateSync({ secret }) },
          headers: new Headers({ cookie }),
          asResponse: true,
        });
        expect(verified.status).toBe(200);
        return { secret, backupCodes: enable.backupCodes as string[] };
      }

      test("AU-05 set-up gives a secret link and 10 backup codes, and the stored secret is not the plain secret", async () => {
        await signUp();
        const cookie = cookieOf(await signIn(PASSWORD, "10.0.0.7"));
        const enable = await a.auth.api.enableTwoFactor({
          body: { password: PASSWORD },
          headers: new Headers({ cookie }),
        });
        const secret = new URL(enable.totpURI).searchParams.get("secret")!;
        expect(enable.backupCodes).toHaveLength(10);
        const stored = (await db.run("select secret, backup_codes from two_factor"))[0]!;
        expect(stored["secret"]).not.toBe(secret);
        expect(String(stored["backup_codes"])).not.toContain(enable.backupCodes[0]);
      });

      test("AU-06 after two-factor is on, sign-in asks for a code; a wrong code gets 401; a right code gets 200", async () => {
        const { secret } = await enrolled();
        const res = await signIn(PASSWORD, "10.0.0.8");
        expect((await res.clone().json()).twoFactorRedirect).toBe(true);
        const cookie = cookieOf(res);
        expect(
          (
            await a.auth.api.verifyTOTP({
              body: { code: "000000" },
              headers: new Headers({ cookie }),
              asResponse: true,
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await a.auth.api.verifyTOTP({
              body: { code: generateSync({ secret }) },
              headers: new Headers({ cookie }),
              asResponse: true,
            })
          ).status,
        ).toBe(200);
      });

      test("AU-07 a backup code works once and fails the second time", async () => {
        const { backupCodes } = await enrolled();
        const use = async (ip: string) => {
          const cookie = cookieOf(await signIn(PASSWORD, ip));
          return (
            await a.auth.api.verifyBackupCode({
              body: { code: backupCodes[0] },
              headers: new Headers({ cookie }),
              asResponse: true,
            })
          ).status;
        };
        expect(await use("10.0.0.9")).toBe(200);
        expect(await use("10.0.0.10")).toBeGreaterThanOrEqual(400);
      });
    });

    test("AU-10 the sign-in route is limited per address, using the database", async () => {
      const codes: number[] = [];
      for (let i = 0; i < 9; i++)
        codes.push(
          (
            await post(
              a,
              "/sign-in/email",
              { email: `nobody${i}@example.com`, password: "wrong password " + i },
              {},
              "203.0.113.9",
            )
          ).status,
        );
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes.slice(5).every((c) => c === 429)).toBe(true);
      const stored = await db.run("select key, count from rate_limits order by count desc");
      expect(stored.length).toBeGreaterThan(0);
    });

    test("AU-12 deleting a user deletes their sessions, accounts and two-factor data", async () => {
      await signUp();
      const id = String(
        (await db.run("select id from users where email = 'anna@example.com'"))[0]!["id"],
      );
      await db.run("delete from users where id = ?", [id]);
      for (const t of ["auth_sessions", "auth_accounts", "two_factor", "passkeys"])
        expect(
          Number((await db.run(`select count(*) as c from ${t} where user_id = ?`, [id]))[0]!["c"]),
          t,
        ).toBe(0);
    });

    test("AU-42 a password change signs out all other sessions", async () => {
      await signUp();
      const keep = cookieOf(await signIn(PASSWORD, "10.0.0.11"));
      const other = cookieOf(await signIn(PASSWORD, "10.0.0.12"));
      expect(await a.auth.api.getSession({ headers: new Headers({ cookie: other }) })).toBeTruthy();
      const res = await a.auth.api.changePassword({
        body: { currentPassword: PASSWORD, newPassword: "a brand new password" },
        headers: new Headers({ cookie: keep }),
        asResponse: true,
      });
      expect(res.status).toBe(200);
      expect(await a.auth.api.getSession({ headers: new Headers({ cookie: other }) })).toBeNull();
      expect(
        await a.auth.api.getSession({ headers: new Headers({ cookie: cookieOf(res) || keep }) }),
      ).toBeTruthy();
    });

    test("AU-41 changing the password asks for the current password", async () => {
      await signUp();
      const cookie = cookieOf(await signIn(PASSWORD, "10.0.0.13"));
      const res = await a.auth.api.changePassword({
        body: { currentPassword: "not my password", newPassword: "a brand new password" },
        headers: new Headers({ cookie }),
        asResponse: true,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      const tfa = await a.auth.api.enableTwoFactor({
        body: { password: "not my password" },
        headers: new Headers({ cookie }),
        asResponse: true,
      });
      expect(tfa.status).toBeGreaterThanOrEqual(400);
    });

    test("AU-45 the session cookie is HTTP-only and same-site; a request with a session from another origin is refused", async () => {
      await signUp();
      const res = await post(
        a,
        "/sign-in/email",
        { email: "anna@example.com", password: PASSWORD },
        {},
        "203.0.113.20",
      );
      expect(res.status).toBe(200);
      const setCookie = res.headers.getSetCookie().find((c) => c.includes("session_token"))!;
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).not.toMatch(/;\s*Secure/i); // the test site is http
      const cookie = cookieOf(res);
      const evil = await post(
        a,
        "/revoke-other-sessions",
        {},
        { origin: "https://evil.example", cookie },
        "203.0.113.21",
      );
      expect(evil.status).toBe(403);
      const own = await post(a, "/revoke-other-sessions", {}, { cookie }, "203.0.113.22");
      expect(own.status).toBe(200);
    });
  });
}
