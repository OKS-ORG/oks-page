// `oks migrate` and `oks user reset` on a real SQLite file (AU-43): the tables are made, the password is replaced and works,
// the person is signed out, the audit log has a line, and a wrong secret key changes nothing.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@oks-page/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const shared = globalThis as typeof globalThis & { __oks?: unknown; __oksAuth?: unknown };
const SECRET = "s".repeat(40);

describe("the oks migrate and oks user reset commands", () => {
  let dir = "";
  const saved: Record<string, string | undefined> = {};
  const keys = ["OKS_SQLITE_PATH", "OKS_DATABASE_URL", "OKS_SECRET", "OKS_SITE_URL"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oks-cmd-"));
    for (const k of keys) saved[k] = process.env[k];
    delete process.env["OKS_DATABASE_URL"];
    process.env["OKS_SQLITE_PATH"] = join(dir, "site.sqlite");
    process.env["OKS_SECRET"] = SECRET;
    process.env["OKS_SITE_URL"] = "http://localhost:3000";
    delete shared.__oks;
    delete shared.__oksAuth;
    vi.resetModules();
  });
  afterEach(() => {
    delete shared.__oks;
    delete shared.__oksAuth;
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = () => {
    const out: string[] = [];
    return { out, say: (t: string) => void out.push(t) };
  };

  test("CLI-10: migrate makes the tables once and then says the database is up to date", async () => {
    const { migrateCommand } = await import("./cli-commands");
    const first = lines();
    expect(await migrateCommand(first.say)).toBe(0);
    expect(first.out[0]).toMatch(/^\d+ changes made to the database\.$/);
    const second = lines();
    expect(await migrateCommand(second.say)).toBe(0);
    expect(second.out).toEqual(["The database is up to date. Nothing was changed."]);
  });

  test("CLI-11: user reset gives a new password that signs in, ends the old sign-ins and writes to the audit log", async () => {
    const { migrateCommand, userResetCommand } = await import("./cli-commands");
    await migrateCommand(() => {});
    const { getRunner } = await import("./db");
    const { runSetup } = await import("@oks-page/core");
    const T = new Date(1_700_000_000_000);
    const userId = newId();
    await runSetup(
      getRunner(),
      async ({ name, email }) => {
        await getRunner().all(
          `insert into "users" ("id", "name", "email", "created_at", "updated_at") values (?, ?, ?, ?, ?)`,
          [userId, name, email, T, T],
        );
        return { userId };
      },
      {
        siteName: "S",
        admin: { name: "Ann", email: "ann@example.com", password: "a-long-password" },
      },
    );
    await getRunner().all(
      `insert into "auth_sessions" ("id", "user_id", "token", "expires_at", "created_at", "updated_at") values (?, ?, 'tok', ?, ?, ?)`,
      [newId(), userId, new Date(T.getTime() + 86_400_000), T, T],
    );
    const result = lines();
    expect(await userResetCommand(["Ann@Example.com"], result.say, process.env)).toBe(0);
    const password = /is now: (\S+)$/.exec(result.out[0]!)![1]!;
    expect(password).toHaveLength(20);
    expect(result.out[1]).toContain("1 sign-in ended");
    const sessions = await getRunner().all(`select id from "auth_sessions"`);
    expect(sessions).toHaveLength(0);
    const audit = await getRunner().all(
      `select "action", "actor_id" from "audit_log" where "action" = 'user.password_reset'`,
    );
    expect(audit).toEqual([{ action: "user.password_reset", actor_id: "oks user reset" }]);
    const { getAuth } = await import("./auth");
    const signIn = (pw: string) =>
      getAuth("http://localhost:3000").auth.api.signInEmail({
        body: { email: "ann@example.com", password: pw },
        asResponse: true,
        headers: { "x-oks-client-ip": "203.0.113.5" },
      });
    expect((await signIn(password)).status).toBe(200);
    expect((await signIn("a-long-password")).status).not.toBe(200);
  });

  test("CLI-12: a wrong secret key, an unknown address and a missing address change nothing and say why", async () => {
    const { migrateCommand, userResetCommand } = await import("./cli-commands");
    await migrateCommand(() => {});
    const wrong = lines();
    expect(
      await userResetCommand(["x@example.com"], wrong.say, { OKS_SECRET: "w".repeat(40) }),
    ).toBe(1);
    expect(wrong.out).toEqual(["Problem: The secret key is wrong. Nothing was changed."]);
    const unknown = lines();
    expect(await userResetCommand(["nobody@example.com"], unknown.say, process.env)).toBe(1);
    expect(unknown.out).toEqual(["Problem: There is no account with that email address."]);
    const none = lines();
    expect(await userResetCommand([], none.say, process.env)).toBe(2);
    expect(none.out).toEqual(["Usage: oks user reset <email>"]);
    const noSecret = lines();
    expect(await userResetCommand(["x@example.com"], noSecret.say, {})).toBe(1);
    expect(noSecret.out[0]).toMatch(/^Problem: OKS_SECRET is not set/);
  });
});
