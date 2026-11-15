// AU-09: a passkey registers, is kept, signs in, and a duplicate credential is refused. A real Chromium with a
// virtual authenticator (a fake fingerprint reader) does the browser part. On SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import type { Server } from "node:http";
import { authFor, findBrowser, startServer } from "./testing.js";
import type { OksAuth } from "./create-auth.js";

const browserPath = findBrowser();
if (!browserPath && process.env["CI"])
  throw new Error("No Chrome or Chromium found, and the passkey tests must run in CI");

let sdk = "";
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: "import * as sw from '@simplewebauthn/browser'; window.sw = sw;",
      resolveDir: join(import.meta.dirname, ".."),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  sdk = result.outputFiles[0]!.text;
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip || !browserPath)(`${kind}: passkeys`, () => {
    let db: TestDb;
    let server: Server | undefined;
    let browser: Browser | undefined;
    afterEach(async () => {
      await browser?.close();
      await new Promise((r) => (server ? server.close(r) : r(null)));
      await db?.close();
    });

    test("AU-09 register, sign out, sign in with the passkey; the use counter and the unique credential hold", async () => {
      db = await open();
      const ref: { auth?: OksAuth } = {};
      const started = await startServer(
        () => ref.auth!.handler,
        () => `<!doctype html><title>passkey test</title><script>${sdk}</script>`,
      );
      server = started.server;
      const url = `http://localhost:${started.port}`;
      const auth = (ref.auth = authFor(db, {
        baseUrl: url,
        passkey: { rpID: "localhost", rpName: "oks test", origin: url },
      }));
      await auth.auth.api.signUpEmail({
        body: { email: "pk@example.com", password: "passkey user password", name: "PK" },
        headers: { "x-oks-client-ip": "10.9.0.1" },
      });

      browser = await chromium.launch({ executablePath: browserPath!, args: ["--no-sandbox"] });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url);
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });

      const login = await page.evaluate(
        async () =>
          (
            await fetch("/api/auth/sign-in/email", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email: "pk@example.com", password: "passkey user password" }),
              credentials: "include",
            })
          ).status,
      );
      expect(login).toBe(200);

      const registered = await page.evaluate(async () => {
        const options = await (
          await fetch("/api/auth/passkey/generate-register-options", { credentials: "include" })
        ).json();
        // @ts-expect-error the SDK is added to the page by the test
        const credential = await window.sw.startRegistration({ optionsJSON: options });
        const send = async (password?: string) =>
          (
            await fetch("/api/auth/passkey/verify-registration", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                response: credential,
                name: "Test key",
                ...(password ? { password } : {}),
              }),
              credentials: "include",
            })
          ).status;
        // Adding a passkey asks for the current password again (AU-41): without it, or with a wrong one, nothing is added.
        return {
          without: await send(),
          wrong: await send("not the password"),
          status: await send("passkey user password"),
        };
      });
      expect(registered.without).toBe(400);
      expect(registered.wrong).toBe(400);
      expect(registered.status).toBe(200);
      const row = (
        await db.run("select credential_id, counter, device_type, name from passkeys")
      )[0]!;
      expect(row["name"]).toBe("Test key");

      await page.evaluate(
        async () =>
          void (await fetch("/api/auth/sign-out", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            credentials: "include",
          })),
      );
      const before = await page.evaluate(
        async () => await (await fetch("/api/auth/get-session", { credentials: "include" })).text(),
      );
      expect(before === "null" || before === "").toBe(true);

      const signedIn = await page.evaluate(async () => {
        const options = await (
          await fetch("/api/auth/passkey/generate-authenticate-options", { credentials: "include" })
        ).json();
        // @ts-expect-error the SDK is added to the page by the test
        const credential = await window.sw.startAuthentication({ optionsJSON: options });
        const r = await fetch("/api/auth/passkey/verify-authentication", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: credential }),
          credentials: "include",
        });
        return r.status;
      });
      expect(signedIn).toBe(200);
      const session = await page.evaluate(
        async () => await (await fetch("/api/auth/get-session", { credentials: "include" })).json(),
      );
      expect(session?.user?.email).toBe("pk@example.com");

      const after = (await db.run("select counter from passkeys"))[0]!;
      expect(Number(after["counter"])).toBeGreaterThanOrEqual(Number(row["counter"]));

      const userId = String((await db.run("select id from users limit 1"))[0]!["id"]);
      await expect(
        db.run(
          "insert into passkeys (id, user_id, name, public_key, credential_id, counter, device_type, backed_up) values (?, ?, 'dup', 'k', ?, 0, 'single', ?)",
          ["DUP00000000000000000000001", userId, row["credential_id"], false],
        ),
      ).rejects.toThrow(/unique|duplicate/i);
    }, 60_000);
  });
}
