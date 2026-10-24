// The per-account sign-in limit (spec 02, section 5; decision D86; AU-38).
//
// After 5 wrong tries on one account, further tries are refused for 60 seconds, then 120, and so on, doubling up
// to one hour. The count resets after 15 minutes without a try (counted from the end of any cool-down) and on a successful
// sign-in. An administrator can clear it. It is counted per lower-cased email, whatever address the tries come
// from, so an attacker who changes address is not helped. Cost: during a cool-down the owner's correct password
// is refused too, so the attacker can delay the owner; the administrator's "clear" is the way out (ADR 0033).
//
// Every attempt is counted BEFORE the password is checked, inside one transaction that holds the row, so many
// parallel guesses cannot all get through before the first one is counted. A successful sign-in clears the row.
import type { SqlRunner } from "@oks-page/db";
import { newId } from "@oks-page/db";

export interface AccountLimitConfig {
  /** Wrong tries before the first cool-down. */
  freeTries: number;
  firstCooldownMs: number;
  maxCooldownMs: number;
  /** The count starts again after this long without a try. */
  resetAfterMs: number;
}

export const DEFAULT_ACCOUNT_LIMIT: AccountLimitConfig = {
  freeTries: 5,
  firstCooldownMs: 60_000,
  maxCooldownMs: 3_600_000,
  resetAfterMs: 15 * 60_000,
};

export type AttemptResult = { allowed: true } | { allowed: false; retryAfterMs: number };

export const accountKey = (email: string) => `acct|${email.trim().toLowerCase()}`;

export function cooldownMs(count: number, c: AccountLimitConfig): number {
  if (count < c.freeTries) return 0;
  return Math.min(c.firstCooldownMs * 2 ** (count - c.freeTries), c.maxCooldownMs);
}

export function createAccountLimiter(
  db: SqlRunner,
  config: AccountLimitConfig = DEFAULT_ACCOUNT_LIMIT,
  clock: () => number = Date.now,
) {
  return {
    /** Count one sign-in attempt for this account, or refuse it. Call before checking the password. */
    async attempt(email: string): Promise<AttemptResult> {
      const key = accountKey(email);
      return db.transaction(async (tx) => {
        const forUpdate = tx.dialect === "postgres" ? " for update" : "";
        // Make sure the row exists, so "for update" has a row to hold. A new row is an empty count.
        await tx.all(
          `insert into "rate_limits" ("id", "key", "count", "last_request_ms") values (?, ?, 0, 0) on conflict ("key") do nothing`,
          [newId(), key],
        );
        const row = (
          await tx.all(
            `select "count", "last_request_ms" from "rate_limits" where "key" = ?${forUpdate}`,
            [key],
          )
        )[0]!;
        const now = clock();
        let count = Number(row["count"]);
        const last = Number(row["last_request_ms"]);
        const wait = cooldownMs(count, config);
        if (count > 0 && now < last + wait)
          return { allowed: false, retryAfterMs: last + wait - now } as const;
        // The 15 minutes count from the end of the cool-down, so a long cool-down cannot clear itself.
        if (count > 0 && now - (last + wait) > config.resetAfterMs) count = 0;
        await tx.all(
          `update "rate_limits" set "count" = ?, "last_request_ms" = ? where "key" = ?`,
          [count + 1, now, key],
        );
        return { allowed: true } as const;
      });
    },
    /** A correct password: the account starts clean. */
    async succeeded(email: string): Promise<void> {
      await db.all(`delete from "rate_limits" where "key" = ?`, [accountKey(email)]);
    },
    /** What an administrator's "unlock" does. Returns whether there was anything to clear. */
    async clear(email: string): Promise<boolean> {
      const rows = await db.all(`delete from "rate_limits" where "key" = ? returning "key"`, [
        accountKey(email),
      ]);
      return rows.length > 0;
    },
    /** Seconds still to wait, for the admin screen; 0 when the account is free. */
    async status(email: string): Promise<{ count: number; retryAfterMs: number }> {
      const row = (
        await db.all(`select "count", "last_request_ms" from "rate_limits" where "key" = ?`, [
          accountKey(email),
        ])
      )[0];
      if (!row) return { count: 0, retryAfterMs: 0 };
      const count = Number(row["count"]);
      return {
        count,
        retryAfterMs: Math.max(
          0,
          Number(row["last_request_ms"]) + cooldownMs(count, config) - clock(),
        ),
      };
    },
  };
}
export type AccountLimiter = ReturnType<typeof createAccountLimiter>;
