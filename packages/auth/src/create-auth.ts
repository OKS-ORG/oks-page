// Better Auth on our own tables, on SQLite or PostgreSQL (spec 02; spike S3).
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { newId, pgSchema, sqliteSchema, type SqlRunner } from "@oks-page/db";
import { timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import {
  accountKey,
  createAccountLimiter,
  DEFAULT_ACCOUNT_LIMIT,
  type AccountLimitConfig,
} from "./account-limit.js";
import { clientAddress, UNKNOWN_CLIENT, type TrustedProxies } from "./client-ip.js";

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
}

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
    emailAndPassword: { enabled: true, minPasswordLength: options.passwordMinLength ?? 10 },
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
    plugins: [twoFactor(), ...(options.passkey ? [passkey(options.passkey)] : [])],
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
        // A password change signs out every other session (spec 02, section 4).
        if (ctx.path === "/change-password" && ctx.body && typeof ctx.body === "object") {
          (ctx.body as Record<string, unknown>)["revokeOtherSessions"] = true;
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const returned = ctx.context.returned as { status?: number } | undefined;
        const failed =
          returned instanceof APIError ||
          (typeof returned?.status === "number" && returned.status >= 400);
        const email = (ctx.body as { email?: string } | undefined)?.email;
        if (!failed && typeof email === "string") await limiter.succeeded(email);
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
