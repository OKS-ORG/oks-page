// The consent notice's side of the site (spec 18, section 2): which purposes the notice asks about, the version that names
// them, the record of what a visitor chose (nothing in it points to a person) and the visitor's remembered choice.
import { newId, type SqlRunner } from "@oks-page/db";
import type { ConsentNeeds } from "./consent-needs";

/** What the notice may ask about, in the order it shows them. `essential` is never asked. */
export const ASKED_PURPOSES = ["statistics", "media", "marketing"] as const;
export type AskedPurpose = (typeof ASKED_PURPOSES)[number];

/** How long a visitor's choice is remembered in their browser (spec 18, section 2). */
export const REMEMBER_DAYS = 183;

/** The purposes the notice asks about: those that a switched-on plugin declares and "media" for videos that load at once. */
export function purposesOf(needs: ConsentNeeds): AskedPurpose[] {
  const found = new Set<string>();
  for (const p of needs.plugins) {
    for (const c of p.cookies) found.add(c.purpose);
    for (const h of p.outsideHosts) found.add(h.purpose);
  }
  if (needs.videos.length > 0) found.add("media");
  return ASKED_PURPOSES.filter((p) => found.has(p));
}

/** What the notice says about itself: whether it shows, what it asks about, and a version that changes when that does. */
export interface ConsentInfo {
  needed: boolean;
  purposes: AskedPurpose[];
  version: string;
}

export function consentInfoOf(needs: ConsentNeeds): ConsentInfo {
  const purposes = purposesOf(needs);
  return { needed: purposes.length > 0, purposes, version: purposes.join(",") };
}

/**
 * Keeps what a visitor chose, as proof that they were asked: the time, the accepted purposes and the notice version. The
 * answer is refused when it is not what the notice offers.
 */
export async function recordConsent(
  runner: SqlRunner,
  siteId: string,
  input: { accepted?: unknown; version?: unknown },
  now: () => number = Date.now,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const bad = { ok: false, message: "The choice was not understood." } as const;
  if (!Array.isArray(input.accepted) || input.accepted.length > ASKED_PURPOSES.length) return bad;
  const accepted = input.accepted as unknown[];
  const known = ASKED_PURPOSES.filter((p) => accepted.includes(p));
  if (known.length !== accepted.length || new Set(accepted).size !== accepted.length) return bad;
  if (typeof input.version !== "string" || !/^[a-z]{0,40}(,[a-z]{1,40}){0,2}$/.test(input.version))
    return bad;
  await runner.all(
    `insert into "consent_records" ("id", "site_id", "choice", "version", "created_at") values (?, ?, ?, ?, ?)`,
    [newId(), siteId, known.join(","), input.version, new Date(now())],
  );
  return { ok: true };
}
