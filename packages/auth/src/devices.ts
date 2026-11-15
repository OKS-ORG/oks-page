// The browsers a person signed in from, for the alert about a sign-in from a new device (spec 13, section 5). A
// browser is known by a random value in a cookie set at sign-in (only for people who sign in; spec 18 lists it); the
// database keeps only its SHA-256 and a short description such as "Firefox on Windows".
import type { SqlRunner } from "@oks-page/db";
import { createHash, randomBytes } from "node:crypto";

export const DEVICE_COOKIE = "oks_device";
/** How long a browser stays known after its last sign-in. */
export const DEVICE_DAYS = 400;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** "Firefox on Windows", from the browser's own description; "a browser" when it says nothing useful. */
export function describeBrowser(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  const system = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  if (browser && system) return `${browser} on ${system}`;
  return browser || (system ? `a browser on ${system}` : "a browser");
}

export interface DeviceCheck {
  /** The value to keep in the cookie (the same one, or a new one). */
  value: string;
  /** True when this browser was not known for this person, and the person had signed in from another one before. */
  alert: boolean;
  description: string;
}

/**
 * Notes a sign-in from this browser. The first browser a person ever signs in from is remembered without an alert;
 * after that, a browser the site does not know gets one. Browsers not seen for 400 days are forgotten.
 */
export async function checkDevice(
  runner: SqlRunner,
  userId: string,
  cookieValue: string | null | undefined,
  userAgent: string | null | undefined,
  now: () => number = Date.now,
): Promise<DeviceCheck> {
  const at = new Date(now());
  await runner.all(`delete from "known_devices" where "user_id" = ? and "last_seen_at" < ?`, [
    userId,
    new Date(now() - DEVICE_DAYS * 24 * 60 * 60 * 1000),
  ]);
  const description = describeBrowser(userAgent);
  const valid = typeof cookieValue === "string" && /^[A-Za-z0-9_-]{43}$/.test(cookieValue);
  if (valid) {
    const known = await runner.all(
      `select 1 from "known_devices" where "user_id" = ? and "device_hash" = ?`,
      [userId, hash(cookieValue)],
    );
    if (known.length > 0) {
      await runner.all(
        `update "known_devices" set "last_seen_at" = ?, "description" = ? where "user_id" = ? and "device_hash" = ?`,
        [at, description, userId, hash(cookieValue)],
      );
      return { value: cookieValue, alert: false, description };
    }
  }
  // A browser this person has not used: keep a value for it (the one it brought, so another person on the same
  // browser keeps it too, or a new one).
  const value = valid ? cookieValue : randomBytes(32).toString("base64url");
  const before = await runner.all(
    `select count(*) as "n" from "known_devices" where "user_id" = ?`,
    [userId],
  );
  await runner.all(
    `insert into "known_devices" ("user_id", "device_hash", "description", "created_at", "last_seen_at")
      values (?, ?, ?, ?, ?)`,
    [userId, hash(value), description, at, at],
  );
  return { value, alert: Number(before[0]?.["n"] ?? 0) > 0, description };
}
