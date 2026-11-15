// Confirming and changing an email address (spec 13, section 5), on SQLite and PostgreSQL: only while email works
// (EM-02), a change only from a confirmed address, the old address asked first, the new one second, and the notice to
// both. The links always lead back to the account page, whatever the browser asked for.
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AccountChange, AddressLinkKind, OksAuth } from "./create-auth.js";
import { authFor, BASE_URL, cookieOf, post } from "./testing.js";

const PASSWORD = "correct horse battery";

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: confirming and changing an email address`, () => {
    let db: TestDb;
    let a: OksAuth;
    let links: { email: string; kind: AddressLinkKind; url: string; address?: string }[];
    let changes: { email: string; change: AccountChange; previous?: string; address?: string }[];
    let ready: boolean;
    let cookie = "";

    beforeEach(async () => {
      db = await open();
      links = [];
      changes = [];
      ready = true;
      a = authFor(db, {
        sendAddressLink: async ({ email, kind, url, address }) => {
          links.push({ email, kind, url, ...(address ? { address } : {}) });
        },
        onAccountChange: async ({ email, change, previous, address }) => {
          changes.push({
            email,
            change,
            ...(previous ? { previous } : {}),
            ...(address ? { address } : {}),
          });
        },
        emailReady: async () => ready,
      });
      const made = await a.auth.api.signUpEmail({
        body: { email: "anna@example.com", password: PASSWORD, name: "Anna" },
        headers: { "x-oks-client-ip": "10.0.0.1" },
        asResponse: true,
      });
      cookie = cookieOf(made);
    });
    afterEach(async () => db.close());

    const visit = (url: string, withCookie = cookie) =>
      a.handler(new Request(url, { headers: withCookie ? { cookie: withCookie } : {} }), {
        remoteAddress: "203.0.113.1",
      });
    const userRow = async () =>
      (await db.run("select email, email_verified from users"))[0] as Record<string, unknown>;

    test("while email does not work, no link is sent", async () => {
      ready = false;
      const asked = await post(
        a,
        "/send-verification-email",
        { email: "anna@example.com" },
        { cookie },
      );
      expect(asked.status).toBe(400);
      expect(JSON.stringify(await asked.json())).toContain("Email is not set up on this site yet");
      const change = await post(a, "/change-email", { newEmail: "new@example.com" }, { cookie });
      expect(change.status).toBe(400);
      expect(links).toEqual([]);
    });

    test("confirm: a link that leads back to the account page, whatever the browser asked for; a made-up link comes back with an error", async () => {
      // Another site is refused by the library itself; the site's own address is replaced by the account page.
      const foreign = await post(
        a,
        "/send-verification-email",
        { email: "anna@example.com", callbackURL: "https://evil.example/steal" },
        { cookie },
      );
      expect(foreign.status).toBe(403);
      expect(links).toEqual([]);
      const asked = await post(
        a,
        "/send-verification-email",
        { email: "anna@example.com", callbackURL: "/somewhere-else" },
        { cookie },
      );
      expect(asked.status).toBe(200);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ email: "anna@example.com", kind: "confirm-email" });
      expect(links[0]!.url.startsWith(`${BASE_URL}/api/auth/verify-email?token=`)).toBe(true);
      expect(links[0]!.url).not.toContain("somewhere");
      const opened = await visit(links[0]!.url);
      expect(opened.status).toBe(302);
      expect(opened.headers.get("location")).toBe("/admin/account?email=confirmed");
      expect(
        Boolean(
          Number((await userRow())["email_verified"]) ||
          (await userRow())["email_verified"] === true,
        ),
      ).toBe(true);
      // A made-up token leads back with an error.
      const bad = await visit(`${BASE_URL}/api/auth/verify-email?token=not-a-token`);
      expect(bad.headers.get("location")).toBe(
        "/admin/account?email=confirmed&error=INVALID_TOKEN",
      );
    });

    test("a change needs a confirmed address; then the old address says yes, the new one too, and both get the notice", async () => {
      const early = await post(
        a,
        "/change-email",
        { newEmail: "anna.new@example.com" },
        { cookie },
      );
      expect(early.status).toBe(400);
      expect(JSON.stringify(await early.json())).toContain(
        "Confirm your current email address first",
      );
      await post(a, "/send-verification-email", { email: "anna@example.com" }, { cookie });
      await visit(links[0]!.url);
      // The session still says "not confirmed" until it is read again; sign in afresh.
      const fresh = await a.auth.api.signInEmail({
        body: { email: "anna@example.com", password: PASSWORD },
        headers: { "x-oks-client-ip": "10.0.0.2" },
        asResponse: true,
      });
      cookie = cookieOf(fresh);

      const change = await post(
        a,
        "/change-email",
        { newEmail: "anna.new@example.com" },
        { cookie },
      );
      expect(change.status).toBe(200);
      expect(links[1]).toMatchObject({
        email: "anna@example.com",
        kind: "change-email-old",
        address: "anna.new@example.com",
      });
      expect((await userRow())["email"]).toBe("anna@example.com");
      // The old address says yes: a link goes to the new one; nothing has changed yet.
      const yes = await visit(links[1]!.url);
      expect(yes.headers.get("location")).toBe("/admin/account?email=check-new");
      expect(links[2]).toMatchObject({ email: "anna.new@example.com", kind: "change-email-new" });
      expect((await userRow())["email"]).toBe("anna@example.com");
      expect(changes).toEqual([]);
      // The new address says yes: changed, and the notice goes to both addresses.
      const done = await visit(links[2]!.url);
      expect(done.headers.get("location")).toBe("/admin/account?email=changed");
      expect((await userRow())["email"]).toBe("anna.new@example.com");
      const notice = {
        change: "email",
        previous: "anna@example.com",
        address: "anna.new@example.com",
      };
      expect(changes).toEqual([
        { email: "anna@example.com", ...notice },
        { email: "anna.new@example.com", ...notice },
      ]);
      // The same link again changes nothing and sends nothing.
      await visit(links[2]!.url);
      expect(changes).toHaveLength(2);
    });
  });
}
