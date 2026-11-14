// The sign-in side of the security emails (spec 13, section 5): the password reset link, and the notices after a
// changed password and after two-factor is turned on or off. On SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { generateSync } from "otplib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AccountChange, OksAuth } from "./create-auth.js";
import { authFor, cookieOf, post } from "./testing.js";

const PASSWORD = "correct horse battery";

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: password reset and the security emails`, () => {
    let db: TestDb;
    let a: OksAuth;
    let resets: { email: string; name: string; token: string }[];
    let changes: { email: string; change: AccountChange }[];

    beforeEach(async () => {
      db = await open();
      resets = [];
      changes = [];
      a = authFor(db, {
        sendResetPassword: async ({ email, name, token }) => {
          resets.push({ email, name, token });
        },
        onAccountChange: async ({ email, change }) => {
          changes.push({ email, change });
        },
      });
      await a.auth.api.signUpEmail({
        body: { email: "anna@example.com", password: PASSWORD, name: "Anna" },
        headers: { "x-oks-client-ip": "10.0.0.1" },
      });
    });
    afterEach(async () => db.close());

    const signIn = (password = PASSWORD, ip = "10.0.0.2") =>
      a.auth.api.signInEmail({
        body: { email: "anna@example.com", password },
        asResponse: true,
        headers: { "x-oks-client-ip": ip },
      });

    test("a reset link for an account, the same answer for an unknown address; the new password works once and signs out everywhere", async () => {
      const other = cookieOf(await signIn(PASSWORD, "10.0.0.3"));
      const asked = await post(a, "/request-password-reset", {
        email: "anna@example.com",
        redirectTo: "/admin/reset-password",
      });
      expect(asked.status).toBe(200);
      const unknown = await post(a, "/request-password-reset", {
        email: "nobody@example.com",
        redirectTo: "/admin/reset-password",
      });
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual(await asked.clone().json());
      expect(resets).toHaveLength(1);
      expect(resets[0]).toMatchObject({ email: "anna@example.com", name: "Anna" });

      const token = resets[0]!.token;
      const reset = await post(a, "/reset-password", {
        newPassword: "a brand new password",
        token,
      });
      expect(reset.status).toBe(200);
      // The link works once.
      expect(
        (await post(a, "/reset-password", { newPassword: "another new password", token })).status,
      ).toBe(400);
      // The old password no longer works; the new one does; every session is gone.
      expect((await signIn(PASSWORD, "10.0.0.4")).status).toBe(401);
      expect((await signIn("a brand new password", "10.0.0.5")).status).toBe(200);
      expect(await a.auth.api.getSession({ headers: new Headers({ cookie: other }) })).toBeNull();
      expect(changes).toEqual([{ email: "anna@example.com", change: "password" }]);
    });

    test("a reset link stops working after 1 hour", async () => {
      await post(a, "/request-password-reset", { email: "anna@example.com" });
      const stored = await db.run("select expires_at from auth_verifications");
      const expires = new Date(stored[0]!["expires_at"] as string | number | Date).getTime();
      expect(Math.abs(expires - Date.now() - 60 * 60 * 1000)).toBeLessThan(60_000);
      // Made to have run out: refused.
      await db.run("update auth_verifications set expires_at = ?", [new Date(Date.now() - 1000)]);
      expect(
        (
          await post(a, "/reset-password", {
            newPassword: "a brand new password",
            token: resets[0]!.token,
          })
        ).status,
      ).toBe(400);
    });

    test("without a way to send the link, password reset is off", async () => {
      const off = authFor(db);
      const asked = await post(off, "/request-password-reset", { email: "anna@example.com" });
      expect(asked.status).toBeGreaterThanOrEqual(400);
    });

    test("a changed password, and two-factor turned on and off, each send a notice; a refused change sends none", async () => {
      const cookie = cookieOf(await signIn(PASSWORD, "10.0.0.6"));
      const wrong = await a.auth.api.changePassword({
        body: { currentPassword: "not my password", newPassword: "a brand new password" },
        headers: new Headers({ cookie }),
        asResponse: true,
      });
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      expect(changes).toEqual([]);
      const changed = await a.auth.api.changePassword({
        body: { currentPassword: PASSWORD, newPassword: "a brand new password" },
        headers: new Headers({ cookie }),
        asResponse: true,
      });
      expect(changed.status).toBe(200);
      expect(changes).toEqual([{ email: "anna@example.com", change: "password" }]);

      const now = cookieOf(changed) || cookie;
      const enable = await a.auth.api.enableTwoFactor({
        body: { password: "a brand new password" },
        headers: new Headers({ cookie: now }),
      });
      // Turning it on counts once its first code is checked.
      expect(changes).toHaveLength(1);
      const secret = new URL(enable.totpURI).searchParams.get("secret")!;
      const verified = await a.auth.api.verifyTOTP({
        body: { code: generateSync({ secret }) },
        headers: new Headers({ cookie: now }),
        asResponse: true,
      });
      expect(verified.status).toBe(200);
      expect(changes.at(-1)).toEqual({ email: "anna@example.com", change: "two-factor-on" });
      const disabled = await a.auth.api.disableTwoFactor({
        body: { password: "a brand new password" },
        headers: new Headers({ cookie: cookieOf(verified) || now }),
        asResponse: true,
      });
      expect(disabled.status).toBe(200);
      expect(changes.map((c) => c.change)).toEqual(["password", "two-factor-on", "two-factor-off"]);
    });

    test("a notice that fails does not undo the change", async () => {
      const failing = authFor(db, {
        onAccountChange: async () => {
          throw new Error("the mail queue is down");
        },
      });
      const cookie = cookieOf(
        await failing.auth.api.signInEmail({
          body: { email: "anna@example.com", password: PASSWORD },
          asResponse: true,
          headers: { "x-oks-client-ip": "10.0.0.7" },
        }),
      );
      const changed = await failing.auth.api.changePassword({
        body: { currentPassword: PASSWORD, newPassword: "a brand new password" },
        headers: new Headers({ cookie }),
        asResponse: true,
      });
      expect(changed.status).toBe(200);
      expect((await signIn("a brand new password", "10.0.0.8")).status).toBe(200);
    });
  });
}
