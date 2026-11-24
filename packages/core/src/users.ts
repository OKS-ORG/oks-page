// The people of a site and how new ones join (spec 02, sections 6 and 7; Settings > Users). A person is a member with one role.
// A new person is invited with a link: the administrator makes the invitation and passes the link on (email sends the same link
// once the mail adapter exists), and the invited person opens it and chooses their own password, so the administrator never knows
// it. An invitation can be used once, expires, can be listed and can be cancelled. Pending invitations are kept in the site's
// `settings` table under the key `invitations`, with only a hash of each link, so reading the database does not give out a link.
import type { SqlRunner } from "@oks-page/db";
import { createHash, randomBytes } from "node:crypto";
import type { Actor } from "./content.js";
import { ensureDefaultRoles } from "./roles.js";
import type { CreateAccount } from "./setup.js";

export const INVITE_DEFAULT_DAYS = 7;
export const INVITE_MAX_DAYS = 30;
export const INVITES_MAX_PENDING = 100;
export const PASSWORD_MIN = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMINISTRATOR = "administrator";

export type UserErrorCode = "forbidden" | "invalid" | "not_found" | "conflict";
export type UserResult<T> =
  ({ ok: true } & T) | { ok: false; code: UserErrorCode; message: string; field?: string };
const fail = (code: UserErrorCode, message: string, field?: string) =>
  ({ ok: false, code, message, ...(field ? { field } : {}) }) as const;

const isOn = (v: unknown): boolean => v === true || Number(v) === 1;
const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const MAY = "users.manage";

// ---- the members -------------------------------------------------------------------------------------------------

export interface Member {
  userId: string;
  name: string;
  email: string;
  roleKey: string;
  roleLabel: string;
  twoFactor: boolean;
  joinedAt: number;
}

export interface RoleChoice {
  key: string;
  label: string;
}

/** Everyone who belongs to the site, with their role, in the order they joined. */
export async function listMembers(runner: SqlRunner, siteId: string): Promise<Member[]> {
  const rows = await runner.all(
    `select u."id", u."name", u."email", u."two_factor_enabled", m."created_at", r."key" as "role_key", r."label" as "role_label"
       from "site_members" m join "users" u on u."id" = m."user_id" join "roles" r on r."id" = m."role_id"
      where m."site_id" = ? order by m."created_at", u."email"`,
    [siteId],
  );
  return rows.map((r) => ({
    userId: String(r["id"]),
    name: String(r["name"]),
    email: String(r["email"]),
    roleKey: String(r["role_key"]),
    roleLabel: String(r["role_label"]),
    twoFactor: isOn(r["two_factor_enabled"]),
    joinedAt: toMs(r["created_at"]),
  }));
}

/** The roles a person can have on this site (the five default ones, and custom ones later). */
export async function listRoles(runner: SqlRunner, siteId: string): Promise<RoleChoice[]> {
  // A site made before a default role existed (Client) gets it the first time the roles are listed.
  await ensureDefaultRoles(runner, siteId);
  const rows = await runner.all(
    `select "key", "label" from "roles" where "site_id" = ? order by "created_at", "key"`,
    [siteId],
  );
  return rows.map((r) => ({ key: String(r["key"]), label: String(r["label"]) }));
}

async function roleId(runner: SqlRunner, siteId: string, key: string): Promise<string | null> {
  await ensureDefaultRoles(runner, siteId);
  const rows = await runner.all(`select "id" from "roles" where "site_id" = ? and "key" = ?`, [
    siteId,
    key,
  ]);
  return rows[0] ? String(rows[0]["id"]) : null;
}

async function administrators(runner: SqlRunner, siteId: string): Promise<string[]> {
  const rows = await runner.all(
    `select m."user_id" from "site_members" m join "roles" r on r."id" = m."role_id"
      where m."site_id" = ? and r."key" = ?`,
    [siteId, ADMINISTRATOR],
  );
  return rows.map((r) => String(r["user_id"]));
}

async function roleOf(runner: SqlRunner, siteId: string, userId: string): Promise<string | null> {
  const rows = await runner.all(
    `select r."key" from "site_members" m join "roles" r on r."id" = m."role_id" where m."site_id" = ? and m."user_id" = ?`,
    [siteId, userId],
  );
  return rows[0] ? String(rows[0]["key"]) : null;
}

/**
 * Gives a member another role. The last administrator cannot be demoted: the site would have nobody who can manage it
 * (AU-40). A member keeps their content; only what they may do changes, from their next request.
 */
export async function changeMemberRole(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  userId: string,
  newRoleKey: string,
): Promise<UserResult<{ roleKey: string }>> {
  if (!actor.can(MAY)) return fail("forbidden", "You may not change who can do what.");
  const current = await roleOf(runner, siteId, userId);
  if (current === null) return fail("not_found", "This person is not a member of the site.");
  const id = await roleId(runner, siteId, String(newRoleKey));
  if (id === null) return fail("invalid", "Choose a role from the list.", "role");
  if (current === ADMINISTRATOR && newRoleKey !== ADMINISTRATOR) {
    const admins = await administrators(runner, siteId);
    if (admins.length <= 1)
      return fail(
        "conflict",
        "This is the last administrator. Make someone else an administrator first.",
      );
  }
  await runner.all(
    `update "site_members" set "role_id" = ? where "site_id" = ? and "user_id" = ?`,
    [id, siteId, userId],
  );
  return { ok: true, roleKey: newRoleKey };
}

/**
 * Takes a person out of the site. They can no longer sign in to the admin of this site; their account and everything they
 * wrote stay. The last administrator, and yourself, cannot be removed.
 */
export async function removeMember(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  userId: string,
): Promise<UserResult<Record<never, never>>> {
  if (!actor.can(MAY)) return fail("forbidden", "You may not remove people.");
  if (userId === actor.userId)
    return fail("conflict", "You cannot remove yourself. Ask another administrator.");
  const current = await roleOf(runner, siteId, userId);
  if (current === null) return fail("not_found", "This person is not a member of the site.");
  if (current === ADMINISTRATOR && (await administrators(runner, siteId)).length <= 1)
    return fail("conflict", "This is the last administrator. It cannot be removed.");
  await runner.all(`delete from "site_members" where "site_id" = ? and "user_id" = ?`, [
    siteId,
    userId,
  ]);
  return { ok: true };
}

// ---- the invitations ---------------------------------------------------------------------------------------------

export interface Invitation {
  id: string;
  name: string;
  email: string;
  roleKey: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

/** What is kept: the invitation and the hash of its link, never the link. */
interface StoredInvitation extends Invitation {
  hash: string;
}

const KEY = "invitations";
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

const decode = (runner: SqlRunner, raw: unknown): StoredInvitation[] => {
  let value = raw;
  if (typeof raw === "string" && runner.dialect !== "postgres") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const items = (value as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as StoredInvitation[]) : [];
};

async function readStored(
  runner: SqlRunner,
  siteId: string,
): Promise<{ items: StoredInvitation[]; revision: number | null }> {
  const rows = await runner.all(
    `select "value", "revision" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, KEY],
  );
  return rows[0]
    ? { items: decode(runner, rows[0]["value"]), revision: Number(rows[0]["revision"]) }
    : { items: [], revision: null };
}

/**
 * Changes the list in one safe step: it is read, changed and written back only if nobody else wrote in between (the revision
 * number), and tried again a few times if somebody did. `change` returns the new list, or null to change nothing.
 */
async function updateStored<T>(
  runner: SqlRunner,
  siteId: string,
  change: (items: StoredInvitation[]) => { items: StoredInvitation[]; result: T } | null,
): Promise<{ done: true; result: T } | { done: false }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { items, revision } = await readStored(runner, siteId);
    const changed = change(items);
    if (!changed) return { done: false };
    const json = JSON.stringify({ items: changed.items });
    if (revision === null) {
      const made = await runner.all(
        `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
         on conflict ("site_id", "key") do nothing returning "revision"`,
        [siteId, KEY, json, new Date()],
      );
      if (made.length > 0) return { done: true, result: changed.result };
    } else {
      const saved = await runner.all(
        `update "settings" set "value" = ?, "revision" = "revision" + 1, "updated_at" = ?
          where "site_id" = ? and "key" = ? and "revision" = ? returning "revision"`,
        [json, new Date(), siteId, KEY, revision],
      );
      if (saved.length > 0) return { done: true, result: changed.result };
    }
  }
  return { done: false };
}

/** An invitation without the hash of its link: the only form that leaves this module. */
const publicOf = (stored: StoredInvitation): Invitation => ({
  id: stored.id,
  name: stored.name,
  email: stored.email,
  roleKey: stored.roleKey,
  invitedBy: stored.invitedBy,
  createdAt: stored.createdAt,
  expiresAt: stored.expiresAt,
});

/** The invitations that have not been used and have not expired. */
export async function listInvitations(
  runner: SqlRunner,
  siteId: string,
  now: number = Date.now(),
): Promise<Invitation[]> {
  const { items } = await readStored(runner, siteId);
  return items.filter((i) => i.expiresAt > now).map(publicOf);
}

export interface InviteInput {
  name: string;
  email: string;
  roleKey: string;
  /** How long the link works, in whole days (1 to 30; 7 when not given). */
  days?: number;
}

/**
 * Makes an invitation. The answer holds the link's token once; only a hash of it is kept. The email must not belong to a
 * person who already has an account, and must not already be invited.
 */
export async function createInvitation(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: InviteInput,
  now: number = Date.now(),
): Promise<UserResult<{ token: string; invitation: Invitation }>> {
  if (!actor.can(MAY)) return fail("forbidden", "You may not invite people.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return fail("invalid", "Enter the person's name.", "name");
  if (Array.from(name).length > 100)
    return fail("invalid", "The name can be at most 100 characters.", "name");
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 200)
    return fail("invalid", "Enter a valid email address.", "email");
  const days = input.days ?? INVITE_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > INVITE_MAX_DAYS)
    return fail("invalid", `A link may last 1 to ${INVITE_MAX_DAYS} days.`, "days");
  if ((await roleId(runner, siteId, String(input.roleKey))) === null)
    return fail("invalid", "Choose a role from the list.", "role");
  const known = await runner.all(`select 1 as found from "users" where lower("email") = ?`, [
    email,
  ]);
  if (known.length > 0)
    return fail("conflict", "Someone with this email already has an account.", "email");

  const token = randomBytes(24).toString("base64url");
  const stored: StoredInvitation = {
    id: randomBytes(9).toString("base64url"),
    name,
    email,
    roleKey: input.roleKey,
    invitedBy: actor.userId,
    createdAt: now,
    expiresAt: now + days * DAY_MS,
    hash: hashOf(token),
  };
  const outcome = await updateStored<UserResult<Record<never, never>>>(runner, siteId, (items) => {
    const live = items.filter((i) => i.expiresAt > now);
    if (live.some((i) => i.email === email))
      return {
        items,
        result: fail(
          "conflict",
          "This email has already been invited. Cancel that invitation first.",
          "email",
        ),
      };
    if (live.length >= INVITES_MAX_PENDING)
      return {
        items,
        result: fail("conflict", `There are already ${INVITES_MAX_PENDING} invitations waiting.`),
      };
    return { items: [...live, stored], result: { ok: true } };
  });
  if (!outcome.done) return fail("conflict", "The invitation could not be saved. Try again.");
  if (!outcome.result.ok) return outcome.result;
  return { ok: true, token, invitation: publicOf(stored) };
}

/** Cancels an invitation. The link stops working at once. */
export async function revokeInvitation(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<UserResult<Record<never, never>>> {
  if (!actor.can(MAY)) return fail("forbidden", "You may not cancel invitations.");
  const outcome = await updateStored<boolean>(runner, siteId, (items) => {
    const kept = items.filter((i) => i.id !== id);
    return { items: kept, result: kept.length !== items.length };
  });
  if (!outcome.done) return fail("conflict", "The invitation could not be cancelled. Try again.");
  return outcome.result ? { ok: true } : fail("not_found", "There is no such invitation.");
}

/** What the invitation page shows: who is invited and as what, or null when the link is wrong, used, cancelled or expired. */
export async function readInvitation(
  runner: SqlRunner,
  siteId: string,
  token: string,
  now: number = Date.now(),
): Promise<(Invitation & { roleLabel: string }) | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const hash = hashOf(token);
  const { items } = await readStored(runner, siteId);
  const found = items.find((i) => i.hash === hash && i.expiresAt > now);
  if (!found) return null;
  const roles = await listRoles(runner, siteId);
  return {
    ...publicOf(found),
    roleLabel: roles.find((r) => r.key === found.roleKey)?.label ?? found.roleKey,
  };
}

/**
 * The invited person chooses a password and joins. The link is taken first, in one safe step, so two people (or two clicks)
 * cannot both use it. If the account or the membership cannot be made, the invitation is put back, so nothing is lost.
 */
export async function acceptInvitation(
  runner: SqlRunner,
  createAccount: CreateAccount,
  siteId: string,
  token: string,
  input: { name?: string; password: string },
  now: number = Date.now(),
): Promise<UserResult<{ userId: string; email: string; roleKey: string }>> {
  if (typeof input.password !== "string" || input.password.length < PASSWORD_MIN)
    return fail("invalid", `The password needs at least ${PASSWORD_MIN} characters.`, "password");
  const hash =
    typeof token === "string" && token.length >= 20 && token.length <= 100 ? hashOf(token) : "";
  if (!hash) return fail("not_found", "This invitation link does not work.");
  const taken = await updateStored<StoredInvitation>(runner, siteId, (items) => {
    const found = items.find((i) => i.hash === hash && i.expiresAt > now);
    return found ? { items: items.filter((i) => i !== found), result: found } : null;
  });
  if (!taken.done)
    return fail(
      "not_found",
      "This invitation link does not work. It may have been used, cancelled or expired.",
    );
  const invitation = taken.result;
  const putBack = () =>
    updateStored<true>(runner, siteId, (items) => ({
      items: [...items, invitation],
      result: true,
    }));

  const name = (typeof input.name === "string" ? input.name.trim() : "") || invitation.name;
  if (Array.from(name).length > 100) {
    await putBack();
    return fail("invalid", "The name can be at most 100 characters.", "name");
  }
  let userId: string;
  try {
    userId = (await createAccount({ name, email: invitation.email, password: input.password }))
      .userId;
  } catch (error) {
    await putBack();
    return fail(
      "invalid",
      error instanceof Error ? error.message : "The account could not be created.",
      "password",
    );
  }
  const role = await roleId(runner, siteId, invitation.roleKey);
  try {
    if (role === null) throw new Error("The role no longer exists.");
    await runner.all(
      `insert into "site_members" ("site_id", "user_id", "role_id", "created_at") values (?, ?, ?, ?)`,
      [siteId, userId, role, new Date(now)],
    );
  } catch (error) {
    // Nothing of the new person is left, and the invitation can be used again.
    await runner.all(`delete from "users" where "id" = ?`, [userId]);
    await putBack();
    return fail(
      "conflict",
      error instanceof Error ? error.message : "The membership could not be saved.",
    );
  }
  return { ok: true, userId, email: invitation.email, roleKey: invitation.roleKey };
}
