// What the `oks` command does inside a project (it finds this file in the project's own copy of the product): `oks migrate` and
// `oks user reset <email>`. The settings (the database and the secret key) are read from the environment, which the
// command line fills from the project's `.env` first.
import { randomBytes } from "node:crypto";
import { getAuth } from "./auth";
import { getRunner, migrateDatabase } from "./db";

type Out = (text: string) => void;

/** `oks migrate`: makes the tables of a new database or brings an older one up to date. */
export async function migrateCommand(out: Out): Promise<number> {
  try {
    const applied = await migrateDatabase();
    out(
      applied.length === 0
        ? "The database is up to date. Nothing was changed."
        : `${applied.length} change${applied.length === 1 ? "" : "s"} made to the database.`,
    );
    return 0;
  } catch (error) {
    out(`Problem: ${(error as Error).message}`);
    return 1;
  }
}

/** A password for one use: 20 characters of letters and digits, written once and kept nowhere else. */
export function oneTimePassword(): string {
  const letters = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => letters[b % letters.length]).join("");
}

/**
 * `oks user reset <email>`: gives the account a new one-time password, signs the person out everywhere and writes a line in
 * the audit log (AU-43). It proves that you run the server by needing the site's secret key (`OKS_SECRET`).
 */
export async function userResetCommand(
  args: string[],
  out: Out,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const email = args.find((a) => !a.startsWith("--"));
  if (!email) {
    out("Usage: oks user reset <email>");
    return 2;
  }
  const secret = env["OKS_SECRET"];
  if (!secret) {
    out(
      "Problem: OKS_SECRET is not set. Run this command in the project's folder, where the .env file is.",
    );
    return 1;
  }
  try {
    getRunner();
    const password = oneTimePassword();
    const result = await getAuth(env["OKS_SITE_URL"] ?? "http://localhost:3000").recover({
      secret,
      email,
      newPassword: password,
    });
    out(`The password of ${email} is now: ${password}`);
    out(
      `${result.sessionsRemoved} sign-in${result.sessionsRemoved === 1 ? "" : "s"} ended. Give the password to the person, ` +
        "and ask them to sign in and change it on the account page. It is not kept anywhere else.",
    );
    return 0;
  } catch (error) {
    out(`Problem: ${(error as Error).message}`);
    return 1;
  }
}
