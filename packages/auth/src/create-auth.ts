// Better Auth on our own tables, on SQLite or PostgreSQL (spec 02; spike S3).
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { newId, pgSchema, sqliteSchema, type SqlRunner } from "@oks-page/db";
import { timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { magicLink, twoFactor } from "better-auth/plugins";
import {
  accountKey,
  createAccountLimiter,
  DEFAULT_ACCOUNT_LIMIT,
  type AccountLimitConfig,
} from "./account-limit.js";
import { clientAddress, UNKNOWN_CLIENT, type TrustedProxies } from "./client-ip.js";
import { checkDevice, DEVICE_COOKIE, DEVICE_DAYS } from "./devices.js";

export interface CreateAuthOptions {
  /** A Drizzle client for the database. */
  db: unknown;
  /** The same database as a runner, for the per-account limit. */
  runner: SqlRunner;
  /** The site's secret key. At least 32 characters. */
  secret: string;
  /** The public address of the site, for example https://example.com. Decides whether cookies are `Secure`. */
  baseUrl: string;
  /** Other addresses that may send sign-in requests from a browser. */
  trustedOrigins?: string[];
  /** Reverse proxies whose forwarding headers may be believed (addresses or ranges such as 10.0.0.0/8). */
  trustedProxies?: TrustedProxies;
  passwordMinLength?: number;
  /** Passkeys need the site's domain. Leave out to switch them off. */
  passkey?: { rpID: string; rpName: string; origin: string };
  accountLimit?: AccountLimitConfig;
  /** Sign-in tries per address in the window (the library's own limit, kept in the database). */
  addressLimit?: { window: number; max: number };
  /** For tests: the time used by the per-account limit. */
  clock?: () => number;
  /**
   * Sends the password reset link (spec 13). Without it, password reset is off. It is called only for an address that
   * has an account; the answer to the person is the same either way.
   */
  sendResetPassword?: (data: AccountPerson & { token: string }) => Promise<void>;
  /** Told after a password, two-factor or email change, for the security email (spec 13, section 5). For an email
   * change it is told twice, once for each address, with the old and the new one. */
  onAccountChange?: (
    data: AccountPerson & { change: AccountChange; previous?: string; address?: string },
  ) => Promise<void>;
  /**
   * Sends a link about an email address (spec 13): confirm it, confirm a change from the old address, or confirm the
   * new one. Without it, confirming and changing an address are off.
   */
  sendAddressLink?: (
    data: AccountPerson & { kind: AddressLinkKind; url: string; address?: string },
  ) => Promise<void>;
  /** Whether email works now (EM-02). Confirming and changing an address are refused while it does not. */
  emailReady?: () => Promise<boolean>;
  /**
   * Sends a sign-in link (spec 13, section 5), or the reason there is none: it works only for a confirmed address
   * without two-factor (the library would skip two-factor, and for an unconfirmed address it deletes the password).
   * Without it, sign-in links are off.
   */
  sendSignInLink?: (
    data: AccountPerson & ({ url: string } | { refused: "two-factor" | "not-confirmed" }),
  ) => Promise<void>;
  /** Told after a passkey was added or removed, for the audit log (spec 02, "always logged"). */
  onPasskeyChange?: (
    data: AccountPerson & { change: "added" | "removed"; name: string },
  ) => Promise<void>;
  /** Told when someone signs in from a browser the site does not know for them (after the first one). */
  onNewDevice?: (
    data: AccountPerson & { when: number; browser: string; address: string },
  ) => Promise<void>;
}

/** How long a sign-in link works. */
export const SIGN_IN_LINK_SECONDS = 15 * 60;

export type AddressLinkKind = "confirm-email" | "change-email-old" | "change-email-new";

/** Where the links about an address lead back to, with what happened (the library adds `error=` when it failed). */
export const ADDRESS_RETURN = {
  confirmed: "/admin/account?email=confirmed",
  checkNew: "/admin/account?email=check-new",
  changed: "/admin/account?email=changed",
} as const;

export interface AccountPerson {
  userId: string;
  email: string;
  name: string;
}
export type AccountChange = "password" | "two-factor-on" | "two-factor-off" | "email";

/** How long a password reset link works (spec 13, section 7: an expired one is never sent late). */
export const RESET_TOKEN_SECONDS = 60 * 60;

const CLIENT_HEADER = "x-oks-client-ip";

/**
 * The parts of the Better Auth object that our code and tests use. Written out, because the library's own type
 * cannot be named from another package (it refers to files inside its dependencies).
 */
export interface AuthInstance {
  // The library's endpoint functions take different arguments each; callers check them against its documentation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: Record<string, (...args: any[]) => Promise<any>>;
  handler: (request: Request) => Promise<Response>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $context: Promise<any>;
}

export interface RecoverInput {
  /** The site's secret key: proof that the person runs the server. */
  secret: string;
  email: string;
  newPassword: string;
}

export interface OksAuth {
  auth: AuthInstance;
  /** What `oks user reset` does (AU-43). Throws when the secret key is wrong. */
  recover(input: RecoverInput): Promise<{ sessionsRemoved: number; auditEntries: number }>;
  handler: (request: Request, connection?: { remoteAddress?: string }) => Promise<Response>;
  limiter: ReturnType<typeof createAccountLimiter>;
}

export function createAuth(options: CreateAuthOptions): OksAuth {
  if (options.secret.length < 32) throw new Error("The secret key must be at least 32 characters");
  const schema = options.runner.dialect === "sqlite" ? sqliteSchema : pgSchema;
  const limiter = createAccountLimiter(
    options.runner,
    options.accountLimit ?? DEFAULT_ACCOUNT_LIMIT,
    options.clock,
  );
  const address = options.addressLimit ?? { window: 300, max: 5 };
  type Person = {
    id: string;
    email: string;
    name?: string | null;
    twoFactorEnabled?: boolean | null;
  };
  const personOf = (user: Person): AccountPerson => ({
    userId: user.id,
    email: user.email,
    name: user.name ?? "",
  });
  /** A security email must never break the change it is about. */
  const notify = async (
    user: Person,
    change: AccountChange,
    extra: { previous?: string; address?: string } = {},
  ) => {
    try {
      await options.onAccountChange?.({ ...personOf(user), change, ...extra });
    } catch {
      // the change is done; the email is only a notice
    }
  };
  const emailOff = async () => (options.emailReady ? !(await options.emailReady()) : false);
  /** What a link about an address says, read before the library checks it (it is checked there, not here). */
  const tokenPayload = (
    token: unknown,
  ): { email?: string; updateTo?: string; requestType?: string } => {
    if (typeof token !== "string") return {};
    try {
      const part = token.split(".")[1] ?? "";
      return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  /**
   * The current password, asked again before something that gives access (spec 02, rule 7; AU-41). It is sent in the body
   * as `password`, taken out before the library reads the body, and checked against the signed-in person's own password.
   */
  const askPasswordAgain = async (ctx: Parameters<typeof getSessionFromCtx>[0]) => {
    const body = ((ctx as { body?: unknown }).body ?? {}) as Record<string, unknown>;
    const password = body["password"];
    delete body["password"];
    const session = await getSessionFromCtx(ctx);
    if (!session) return;
    const account = (
      await options.runner.all(
        `select "password" from "auth_accounts" where "user_id" = ? and "provider_id" = 'credential'`,
        [session.user.id],
      )
    )[0];
    const hash = account?.["password"];
    const right =
      typeof password === "string" &&
      typeof hash === "string" &&
      (await (
        ctx as unknown as {
          context: {
            password: { verify: (a: { hash: string; password: string }) => Promise<boolean> };
          };
        }
      ).context.password.verify({ hash, password }));
    if (!right)
      throw new APIError("BAD_REQUEST", { message: "Your current password is not right." });
  };
  /** Names of passkeys about to be removed, by id, for the audit log. */
  const removing = new Map<string, string>();
  /** Email changes waiting for their last link, by token: who it was and the old address. */
  const changing = new Map<string, { userId: string; previous: string; address: string }>();

  const auth = betterAuth({
    database: drizzleAdapter(options.db as never, {
      provider: options.runner.dialect === "sqlite" ? "sqlite" : "pg",
      schema: {
        user: schema.users,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
        twoFactor: schema.twoFactor,
        passkey: schema.passkeys,
        rateLimit: schema.rateLimits,
      },
    }),
    secret: options.secret,
    baseURL: options.baseUrl,
    trustedOrigins: [options.baseUrl, ...(options.trustedOrigins ?? [])],
    logger: { level: "error" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: options.passwordMinLength ?? 10,
      ...(options.sendResetPassword
        ? {
            resetPasswordTokenExpiresIn: RESET_TOKEN_SECONDS,
            // A new password signs out every session, as a changed one does (spec 02, section 4).
            revokeSessionsOnPasswordReset: true,
            sendResetPassword: async ({ user, token }: { user: Person; token: string }) =>
              options.sendResetPassword!({ ...personOf(user), token }),
            onPasswordReset: async ({ user }: { user: Person }) => notify(user, "password"),
          }
        : {}),
    },
    ...(options.sendAddressLink
      ? {
          // Confirming an address, and changing it (spec 13, section 5). Signing in never waits for a confirmed address,
          // so nobody is locked out; changing one needs the current one confirmed (see the hook below).
          emailVerification: {
            expiresIn: RESET_TOKEN_SECONDS,
            sendOnSignUp: false,
            autoSignInAfterVerification: false,
            sendVerificationEmail: async ({ user, url }: { user: Person; url: string }) => {
              // During a change the library passes the new address with the same person.
              const rows = await options.runner.all(`select "email" from "users" where "id" = ?`, [
                user.id,
              ]);
              const current = String(rows[0]?.["email"] ?? user.email).toLowerCase();
              const kind: AddressLinkKind =
                current === user.email.toLowerCase() ? "confirm-email" : "change-email-new";
              await options.sendAddressLink!({ ...personOf(user), kind, url });
            },
          },
          user: {
            changeEmail: {
              enabled: true,
              sendChangeEmailConfirmation: async ({
                user,
                newEmail,
                url,
              }: {
                user: Person;
                newEmail: string;
                url: string;
              }) =>
                options.sendAddressLink!({
                  ...personOf(user),
                  kind: "change-email-old",
                  url,
                  address: newEmail,
                }),
            },
          },
        }
      : {}),
    advanced: {
      database: { generateId: () => newId() },
      // Only the header our own wrapper writes is read. Anything the browser sends under other names is ignored.
      ipAddress: { ipAddressHeaders: [CLIENT_HEADER] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      // The library skips these checks when it thinks it is running under a test (NODE_ENV=test). They are switched
      // on explicitly, so the product behaves the same everywhere and the tests see what production does (AU-45).
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    // On in every mode (the library turns it on only in production), in the database, so it works with several servers.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: address.window, max: address.max } },
    },
    plugins: [
      twoFactor(),
      ...(options.passkey ? [passkey(options.passkey)] : []),
      ...(options.sendSignInLink
        ? [
            magicLink({
              expiresIn: SIGN_IN_LINK_SECONDS,
              // A link never makes an account; the token is kept only as a hash.
              disableSignUp: true,
              storeToken: "hashed",
              sendMagicLink: async ({ email, url }: { email: string; url: string }) => {
                const rows = await options.runner.all(
                  `select "id", "email", "name", "email_verified", "two_factor_enabled" from "users" where lower("email") = ?`,
                  [email.trim().toLowerCase()],
                );
                const row = rows[0];
                // No account: nothing is sent, and the page answers the same.
                if (!row) return;
                const person = {
                  userId: String(row["id"]),
                  email: String(row["email"]),
                  name: String(row["name"] ?? ""),
                };
                const on = (v: unknown) => v === true || Number(v) === 1;
                if (on(row["two_factor_enabled"]))
                  return options.sendSignInLink!({ ...person, refused: "two-factor" });
                if (!on(row["email_verified"]))
                  return options.sendSignInLink!({ ...person, refused: "not-confirmed" });
                return options.sendSignInLink!({ ...person, url });
              },
            }),
          ]
        : []),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/email") {
          const email = (ctx.body as { email?: string } | undefined)?.email;
          if (typeof email !== "string") return;
          const result = await limiter.attempt(email);
          if (!result.allowed) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Too many tries for this account. Wait a little and try again.",
              retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
            });
          }
        }
        // A sign-in link needs email, and always leads to the dashboard (or back to the sign-in page when it failed).
        if (ctx.path === "/sign-in/magic-link") {
          if (await emailOff())
            throw new APIError("BAD_REQUEST", {
              message: "Email is not set up on this site yet, so no link can be sent.",
            });
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          body["callbackURL"] = "/admin";
          body["errorCallbackURL"] = "/admin/login?link=failed";
          delete body["newUserCallbackURL"];
        }
        // Changing the address asks for the current password again (spec 02, rule 7).
        if (ctx.path === "/change-email") await askPasswordAgain(ctx);
        // Adding or removing a passkey asks for it too (AU-41): a passkey is a way in, like a password.
        if (ctx.path === "/passkey/verify-registration" || ctx.path === "/passkey/delete-passkey") {
          await askPasswordAgain(ctx);
          if (ctx.path === "/passkey/delete-passkey") {
            const id = (ctx.body as { id?: unknown } | undefined)?.id;
            const session = await getSessionFromCtx(ctx);
            if (typeof id === "string" && session) {
              const row = (
                await options.runner.all(
                  `select "name" from "passkeys" where "id" = ? and "user_id" = ?`,
                  [id, session.user.id],
                )
              )[0];
              removing.set(id, String(row?.["name"] ?? ""));
            }
          }
        }
        // Confirming or changing an address needs email (EM-02), and always comes back to the account page.
        if (ctx.path === "/send-verification-email" || ctx.path === "/change-email") {
          if (await emailOff())
            throw new APIError("BAD_REQUEST", {
              message: "Email is not set up on this site yet, so no link can be sent.",
            });
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          body["callbackURL"] =
            ctx.path === "/change-email" ? ADDRESS_RETURN.changed : ADDRESS_RETURN.confirmed;
          // A new address only for a confirmed current one: the old address must say yes first, so a stolen
          // session cannot move the account to another mailbox.
          if (ctx.path === "/change-email") {
            const session = await getSessionFromCtx(ctx);
            if (session && !session.user.emailVerified)
              throw new APIError("BAD_REQUEST", {
                message: "Confirm your current email address first. Then you can change it.",
              });
          }
        }
        // The link of an address: back to the account page with what it did; an email change is remembered for its notice.
        if (ctx.path === "/verify-email" && ctx.query && typeof ctx.query === "object") {
          const token = (ctx.query as Record<string, unknown>)["token"];
          const payload = tokenPayload(token);
          (ctx.query as Record<string, unknown>)["callbackURL"] =
            payload.requestType === "change-email-confirmation"
              ? ADDRESS_RETURN.checkNew
              : payload.updateTo
                ? ADDRESS_RETURN.changed
                : ADDRESS_RETURN.confirmed;
          if (
            payload.requestType === "change-email-verification" &&
            payload.email &&
            payload.updateTo
          ) {
            const rows = await options.runner.all(
              `select "id" from "users" where lower("email") = ?`,
              [payload.email.toLowerCase()],
            );
            if (rows[0])
              changing.set(String(token), {
                userId: String(rows[0]["id"]),
                previous: payload.email,
                address: payload.updateTo,
              });
          }
        }
        // A password change signs out every other session (spec 02, section 4).
        if (ctx.path === "/change-password" && ctx.body && typeof ctx.body === "object") {
          (ctx.body as Record<string, unknown>)["revokeOtherSessions"] = true;
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // A sign-in from a browser the site does not know for this person: remember it, and send the alert. Every
        // way of signing in counts once its session exists (password, the code after it, passkey, sign-in link).
        const fresh = ctx.context.newSession as
          | { user?: Person; session?: { userAgent?: string | null; ipAddress?: string | null } }
          | null
          | undefined;
        const answer = ctx.context.returned as { twoFactorRedirect?: unknown } | undefined;
        if (
          fresh?.user &&
          ctx.path !== "/sign-up/email" &&
          ctx.path !== "/verify-email" &&
          !(answer && typeof answer === "object" && "twoFactorRedirect" in answer)
        ) {
          try {
            const device = await checkDevice(
              options.runner,
              fresh.user.id,
              ctx.getCookie(DEVICE_COOKIE),
              fresh.session?.userAgent ?? ctx.headers?.get("user-agent"),
              options.clock,
            );
            ctx.setCookie(DEVICE_COOKIE, device.value, {
              httpOnly: true,
              sameSite: "lax",
              secure: options.baseUrl.startsWith("https://"),
              path: "/",
              maxAge: DEVICE_DAYS * 24 * 60 * 60,
            });
            if (device.alert)
              await options.onNewDevice?.({
                ...personOf(fresh.user),
                when: (options.clock ?? Date.now)(),
                browser: device.description,
                address: fresh.session?.ipAddress ?? ctx.headers?.get(CLIENT_HEADER) ?? "",
              });
          } catch {
            // The sign-in is done; the alert is only a notice.
          }
        }
        // An email change is done when the person now has the new address (the library answers with a redirect
        // either way, so the database decides). The notice goes to the old address and to the new one.
        if (ctx.path === "/verify-email") {
          const token = String((ctx.query as Record<string, unknown> | undefined)?.["token"] ?? "");
          const change = changing.get(token);
          changing.delete(token);
          if (!change) return;
          const rows = await options.runner.all(
            `select "id", "email", "name" from "users" where "id" = ?`,
            [change.userId],
          );
          const user = rows[0];
          if (!user || String(user["email"]).toLowerCase() !== change.address.toLowerCase()) return;
          const person = {
            id: change.userId,
            email: change.previous,
            name: String(user["name"] ?? ""),
          };
          const extra = { previous: change.previous, address: change.address };
          await notify(person, "email", extra);
          await notify({ ...person, email: change.address }, "email", extra);
          return;
        }
        const returned = ctx.context.returned as { status?: number } | undefined;
        const failed =
          returned instanceof APIError ||
          (typeof returned?.status === "number" && returned.status >= 400);
        if (failed) return;
        if (ctx.path === "/sign-in/email") {
          const email = (ctx.body as { email?: string } | undefined)?.email;
          if (typeof email === "string") await limiter.succeeded(email);
          return;
        }
        // The security emails: a changed password, two-factor turned off, or turned on (its first code checked).
        const user = (ctx.context.session as { user?: Person } | null | undefined)?.user;
        if (!user) return;
        // A passkey added or removed: for the audit log. It never undoes the change.
        if (ctx.path === "/passkey/verify-registration" || ctx.path === "/passkey/delete-passkey") {
          try {
            let name = "";
            if (ctx.path === "/passkey/delete-passkey") {
              const id = String((ctx.body as { id?: unknown } | undefined)?.id ?? "");
              name = removing.get(id) ?? "";
              removing.delete(id);
            } else {
              const row = (
                await options.runner.all(
                  `select "name" from "passkeys" where "user_id" = ? order by "created_at" desc limit 1`,
                  [user.id],
                )
              )[0];
              name = String(row?.["name"] ?? "");
            }
            await options.onPasskeyChange?.({
              ...personOf(user),
              change: ctx.path === "/passkey/delete-passkey" ? "removed" : "added",
              name,
            });
          } catch {
            // the change is done; the log entry is only a record
          }
          return;
        }
        if (ctx.path === "/change-password") await notify(user, "password");
        else if (ctx.path === "/two-factor/disable") await notify(user, "two-factor-off");
        else if (ctx.path === "/two-factor/verify-totp" && !user.twoFactorEnabled) {
          const now = await options.runner.all(
            `select "two_factor_enabled" from "users" where "id" = ?`,
            [user.id],
          );
          const on = now[0]?.["two_factor_enabled"];
          if (on === true || on === 1) await notify(user, "two-factor-on");
        }
      }),
    },
  });

  /**
   * The function for the HTTP route. It decides the client address itself (from the connection and the trusted
   * proxies) and removes whatever the sender wrote in the headers the library might read, so a made-up
   * `X-Forwarded-For` cannot hide an attacker or frame someone else (AU-39).
   */
  function handler(
    request: Request,
    connection: { remoteAddress?: string } = {},
  ): Promise<Response> {
    const headers = new Headers(request.headers);
    const ip = clientAddress(
      headers.get("x-forwarded-for"),
      connection.remoteAddress,
      options.trustedProxies,
    );
    for (const name of [
      "x-forwarded-for",
      "x-real-ip",
      "cf-connecting-ip",
      "x-client-ip",
      "forwarded",
      CLIENT_HEADER,
    ])
      headers.delete(name);
    headers.set(CLIENT_HEADER, ip || UNKNOWN_CLIENT);
    return auth.handler(new Request(request, { headers }));
  }

  async function recover(input: RecoverInput) {
    const given = Buffer.from(input.secret);
    const real = Buffer.from(options.secret);
    if (given.length !== real.length || !timingSafeEqual(given, real))
      throw new Error("The secret key is wrong. Nothing was changed.");
    const minLength = options.passwordMinLength ?? 10;
    if (input.newPassword.length < minLength)
      throw new Error(`The new password must have at least ${minLength} characters.`);
    const context = await (auth as unknown as AuthInstance).$context;
    const hash: string = await context.password.hash(input.newPassword);
    const now = new Date();
    return options.runner.transaction(async (tx) => {
      const user = (
        await tx.all(`select "id" from "users" where lower("email") = ?`, [
          input.email.trim().toLowerCase(),
        ])
      )[0];
      if (!user) throw new Error("There is no account with that email address.");
      const userId = String(user["id"]);
      const updated = await tx.all(
        `update "auth_accounts" set "password" = ?, "updated_at" = ? where "user_id" = ? and "provider_id" = 'credential' returning "id"`,
        [hash, now, userId],
      );
      if (updated.length === 0) {
        await tx.all(
          `insert into "auth_accounts" ("id", "user_id", "account_id", "provider_id", "password", "created_at", "updated_at") values (?, ?, ?, 'credential', ?, ?, ?)`,
          [newId(), userId, userId, hash, now, now],
        );
      }
      const sessions = await tx.all(
        `delete from "auth_sessions" where "user_id" = ? returning "id"`,
        [userId],
      );
      await tx.all(`delete from "rate_limits" where "key" = ?`, [accountKey(input.email)]);
      // One audit entry in every site the person belongs to.
      const sites = await tx.all(`select "site_id" from "site_members" where "user_id" = ?`, [
        userId,
      ]);
      for (const site of sites) {
        await tx.all(
          `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id", "detail", "created_at") values (?, ?, 'system', 'oks user reset', 'user.password_reset', 'user', ?, ?, ?)`,
          [
            newId(),
            site["site_id"],
            userId,
            JSON.stringify({ sessionsRemoved: sessions.length }),
            now,
          ],
        );
      }
      return { sessionsRemoved: sessions.length, auditEntries: sites.length };
    });
  }

  return { auth: auth as unknown as AuthInstance, recover, handler, limiter };
}
