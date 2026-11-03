// First-run setup (installation guide, "First run: the setup wizard"; spec 02, section 3, rule 2): makes the site, its
// five default roles, the first account as Administrator, and the first settings. It runs once: after an Administrator
// exists it refuses, so the wizard cannot be opened again.
import { newId, type SqlRunner } from "@oks-page/db";
import { DEFAULT_ROLES } from "./roles.js";

export const SITE_PURPOSES = ["blog", "business", "portfolio", "other"] as const;
export type SitePurpose = (typeof SITE_PURPOSES)[number];

export interface SetupInput {
  siteName: string;
  tagline?: string;
  purpose?: SitePurpose;
  admin: { name: string; email: string; password: string };
}

export interface SetupResult {
  siteId: string;
  userId: string;
}

/** Makes the account (with Better Auth in the real site) and returns its id. It throws a plain message when it refuses. */
export type CreateAccount = (account: {
  name: string;
  email: string;
  password: string;
}) => Promise<{ userId: string }>;

export type SetupErrorCode = "invalid" | "already_set_up" | "account";

export class SetupError extends Error {
  constructor(
    readonly code: SetupErrorCode,
    message: string,
    /** For `invalid`: the form field to show the message at. */
    readonly field?: string,
  ) {
    super(message);
    this.name = "SetupError";
  }
}

const MIN_PASSWORD = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True once an Administrator exists. Then the wizard is closed. */
export async function isSetupDone(runner: SqlRunner): Promise<boolean> {
  const rows = await runner.all(
    `select 1 as found from "site_members" m join "roles" r on r."id" = m."role_id" where r."key" = ? limit 1`,
    ["administrator"],
  );
  return rows.length > 0;
}

function check(input: SetupInput): void {
  const fail = (field: string, message: string): never => {
    throw new SetupError("invalid", message, field);
  };
  if (!input.siteName?.trim()) fail("siteName", "Enter a name for the site.");
  if (input.siteName.length > 200) fail("siteName", "The site name can be at most 200 characters.");
  if ((input.tagline ?? "").length > 300)
    fail("tagline", "The tagline can be at most 300 characters.");
  if (input.purpose !== undefined && !SITE_PURPOSES.includes(input.purpose))
    fail("purpose", "Choose what the site is for.");
  if (!input.admin?.name?.trim()) fail("name", "Enter your name.");
  if (!EMAIL.test(input.admin.email ?? "")) fail("email", "Enter a valid email address.");
  if ((input.admin.password ?? "").length < MIN_PASSWORD)
    fail("password", `The password needs at least ${MIN_PASSWORD} characters.`);
}

export async function runSetup(
  runner: SqlRunner,
  createAccount: CreateAccount,
  input: SetupInput,
  now: () => number = Date.now,
): Promise<SetupResult> {
  check(input);
  if (await isSetupDone(runner))
    throw new SetupError("already_set_up", "This site is already set up.");

  // The account is made first, so a refused password or an email that is taken leaves no half-made site behind.
  let userId: string;
  try {
    userId = (await createAccount(input.admin)).userId;
  } catch (error) {
    throw new SetupError(
      "account",
      error instanceof Error ? error.message : "The account could not be created.",
    );
  }

  try {
    return await runner.transaction(async (tx) => {
      // Two people opening the wizard at the same moment: the second waits here, then finds the first one's site.
      if (tx.dialect === "postgres")
        await tx.exec(`lock table "sites" in share row exclusive mode`);
      if (await isSetupDone(tx))
        throw new SetupError("already_set_up", "This site is already set up.");
      const at = new Date(now());
      const siteId = newId();
      await tx.all(
        `insert into "sites" ("id", "name", "created_at", "updated_at") values (?, ?, ?, ?)`,
        [siteId, input.siteName.trim(), at, at],
      );
      let administratorRole = "";
      for (const role of DEFAULT_ROLES) {
        const roleId = newId();
        if (role.key === "administrator") administratorRole = roleId;
        await tx.all(
          `insert into "roles" ("id", "site_id", "key", "label", "is_system", "created_at") values (?, ?, ?, ?, ?, ?)`,
          [roleId, siteId, role.key, role.label, true, at],
        );
        for (const capability of role.capabilities)
          await tx.all(
            `insert into "role_capabilities" ("id", "role_id", "capability", "scope_type_key") values (?, ?, ?, ?)`,
            [newId(), roleId, capability, ""],
          );
      }
      await tx.all(
        `insert into "site_members" ("site_id", "user_id", "role_id", "created_at") values (?, ?, ?, ?)`,
        [siteId, userId, administratorRole, at],
      );
      const settings: [string, unknown][] = [
        ["title", input.siteName.trim()],
        ["tagline", (input.tagline ?? "").trim()],
        ["purpose", input.purpose ?? "blog"],
      ];
      for (const [key, value] of settings)
        await tx.all(
          `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, ?, ?)`,
          [siteId, key, JSON.stringify(value), 1, at],
        );
      return { siteId, userId };
    });
  } catch (error) {
    // Nothing of the site was saved. The account is removed too, so the person can try again with the same email.
    await runner.all(`delete from "users" where "id" = ?`, [userId]);
    throw error;
  }
}
