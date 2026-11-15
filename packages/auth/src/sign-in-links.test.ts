// Sign-in links and the alert about a sign-in from a new device (spec 13, section 5), on SQLite and PostgreSQL.
// A link only for a confirmed address without two-factor (the library would skip two-factor, and for an unconfirmed
// address it would delete the password); otherwise the reason is emailed and the password stays.
import { openers, type TestDb } from "@oks-page/db/testing";
import { generateSync } from "otplib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OksAuth } from "./create-auth.js";
import { describeBrowser } from "./devices.js";
import { authFor, BASE_URL, cookieOf, post } from "./testing.js";

const PASSWORD = "correct horse battery";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("browsers in plain words", () => {
  test("browser and system", () => {
    expect(describeBrowser(FIREFOX)).toBe("Firefox on Windows");
    expect(describeBrowser(SAFARI)).toBe("Safari on iOS");
    expect(
      describeBrowser(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0",
      ),
    ).toBe("Edge on macOS");
    expect(describeBrowser("curl/8.5")).toBe("a browser");
    expect(describeBrowser(undefined)).toBe("a browser");
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: sign-in links and new devices`, () => {
    let db: TestDb;
    let a: OksAuth;
    let ready: boolean;
    let sent: { email: string; url?: string; refused?: string }[];
    let alerts: { email: string; browser: string; address: string }[];

    beforeEach(async () => {
      db = await open();
      ready = true;
      sent = [];
      alerts = [];
      a = authFor(db, {
        emailReady: async () => ready,
        sendSignInLink: async (data) => {
          sent.push(
            "url" in data
              ? { email: data.email, url: data.url }
              : { email: data.email, refused: data.refused },
          );
        },
        onNewDevice: async ({ email, browser, address }) => {
          alerts.push({ email, browser, address });
        },
      });
      await a.auth.api.signUpEmail({
        body: { email: "anna@example.com", password: PASSWORD, name: "Anna" },
        headers: { "x-oks-client-ip": "10.0.0.1" },
      });
    });
    afterEach(async () => db.close());

    const ask = (email = "anna@example.com", body: Record<string, unknown> = {}) =>
      post(a, "/sign-in/magic-link", { email, ...body });
    const visit = (url: string, headers: Record<string, string> = {}) =>
      a.handler(new Request(url, { headers }), { remoteAddress: "203.0.113.9" });
    const passwordOf = async () =>
      (await db.run("select password from auth_accounts where provider_id = 'credential'"))[0]?.[
        "password"
      ];
    const signIn = (headers: Record<string, string> = {}, remoteAddress = "203.0.113.5") =>
      post(
        a,
        "/sign-in/email",
        { email: "anna@example.com", password: PASSWORD },
        headers,
        remoteAddress,
      );

    test("no link while email does not work; for an unknown address nothing is sent; the answer is the same", async () => {
      ready = false;
      expect((await ask()).status).toBe(400);
      ready = true;
      const unknown = await ask("nobody@example.com");
      const known = await ask();
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual(await known.json());
      expect(sent.map((s) => s.email)).toEqual(["anna@example.com"]);
      // Links never make accounts.
      expect((await db.run("select id from users where email = 'nobody@example.com'")).length).toBe(
        0,
      );
    });

    test("an unconfirmed address gets the reason, not a link, and keeps its password", async () => {
      const before = await passwordOf();
      expect((await ask()).status).toBe(200);
      expect(sent).toEqual([{ email: "anna@example.com", refused: "not-confirmed" }]);
      expect(await passwordOf()).toBe(before);
      expect((await signIn()).status).toBe(200);
    });

    test("a confirmed address without two-factor gets a link: it signs in once, leads to the dashboard, and is kept only as a hash", async () => {
      await db.run("update users set email_verified = ?", [db.kind === "sqlite" ? 1 : true]);
      // Whatever the browser asks for, the link leads to the dashboard.
      await ask("anna@example.com", { callbackURL: "/somewhere" });
      const url = sent[0]!.url!;
      expect(url.startsWith(`${BASE_URL}/api/auth/magic-link/verify?token=`)).toBe(true);
      const token = new URL(url).searchParams.get("token")!;
      const stored = await db.run("select identifier, value from auth_verifications");
      expect(JSON.stringify(stored)).not.toContain(token);
      const opened = await visit(url);
      expect(opened.status).toBe(302);
      expect(opened.headers.get("location")).toBe(`${BASE_URL}/admin`);
      const session = await a.auth.api.getSession({
        headers: new Headers({ cookie: cookieOf(opened) }),
      });
      expect(session?.user.email).toBe("anna@example.com");
      // Once only.
      const again = await visit(url);
      expect(again.headers.get("location")).toBe(
        `${BASE_URL}/admin/login?link=failed&error=INVALID_TOKEN`,
      );
      // The password is still there.
      expect(await passwordOf()).toBeTruthy();
    });

    test("an account with two-factor gets the reason, not a link", async () => {
      await db.run("update users set email_verified = ?", [db.kind === "sqlite" ? 1 : true]);
      const cookie = cookieOf(await signIn());
      const enabled = await post(a, "/two-factor/enable", { password: PASSWORD }, { cookie });
      const uri = ((await enabled.json()) as { totpURI: string }).totpURI;
      const secret = new URL(uri).searchParams.get("secret")!;
      await post(a, "/two-factor/verify-totp", { code: generateSync({ secret }) }, { cookie });
      await ask();
      expect(sent).toEqual([{ email: "anna@example.com", refused: "two-factor" }]);
    });

    test("new device: the first browser is remembered quietly; a known one is quiet; an unknown one gets the alert", async () => {
      const first = await signIn({ "user-agent": FIREFOX });
      expect(first.status).toBe(200);
      const device = first.headers.getSetCookie().find((c) => c.startsWith("oks_device="));
      expect(device).toMatch(/HttpOnly/i);
      expect(device).toMatch(/SameSite=Lax/i);
      expect(alerts).toEqual([]);
      const deviceCookie = device!.split(";")[0]!;
      // The same browser again: quiet.
      expect((await signIn({ "user-agent": FIREFOX, cookie: deviceCookie })).status).toBe(200);
      expect(alerts).toEqual([]);
      // Another browser: the alert, with the browser and the network address.
      expect((await signIn({ "user-agent": SAFARI }, "198.51.100.23")).status).toBe(200);
      expect(alerts).toEqual([
        { email: "anna@example.com", browser: "Safari on iOS", address: "198.51.100.23" },
      ]);
      // Only a hash of the cookie is kept.
      const value = deviceCookie.split("=")[1]!;
      expect(JSON.stringify(await db.run("select * from known_devices"))).not.toContain(value);
      expect(
        (await db.run("select description from known_devices order by description")).map(
          (r) => r["description"],
        ),
      ).toEqual(["Firefox on Windows", "Safari on iOS"]);
      // A wrong password signs nobody in and sends nothing.
      await post(a, "/sign-in/email", { email: "anna@example.com", password: "wrong one" });
      expect(alerts).toHaveLength(1);
    });
  });
}
