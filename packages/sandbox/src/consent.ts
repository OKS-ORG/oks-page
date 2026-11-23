// What a plugin says about the cookies it sets and the other companies it calls (spec 18, section 2). The site uses it to
// know when a consent notice is needed, to list them in Settings > Privacy and to write them into the privacy page draft.
// Nothing here runs code.

export const CONSENT_MOST = 10;

/** Why a cookie is set or a company is called. `essential` needs no consent (it is needed for what the visitor asked for). */
export const CONSENT_PURPOSES = ["essential", "statistics", "media", "marketing"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** A cookie the plugin sets in a visitor's browser. */
export interface PluginCookie {
  name: string;
  purpose: ConsentPurpose;
  /** What it is for, in plain words (shown to the owner and in the privacy page). */
  why: string;
  /** How long it stays, in words ("session", "30 days"). */
  keptFor?: string;
}

/** Another company's address the plugin calls from the visitor's browser. */
export interface PluginOutsideHost {
  host: string;
  purpose: ConsentPurpose;
  why: string;
}

const COOKIE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max ? v : null;

const purposeOf = (v: unknown): ConsentPurpose | null =>
  CONSENT_PURPOSES.find((p) => p === v) ?? null;

/** The cookies a manifest declares, or the words for what is wrong with them. */
export function readCookies(value: unknown): PluginCookie[] | string {
  if (!Array.isArray(value)) return "The plugin's cookies must be a list.";
  if (value.length > CONSENT_MOST) return "The plugin declares too many cookies.";
  const out: PluginCookie[] = [];
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const bad = (why: string) =>
      `The cookie "${String(r["name"] ?? "").slice(0, 40)}" is not valid: ${why}`;
    const name = r["name"];
    if (typeof name !== "string" || !COOKIE_NAME.test(name))
      return bad("its name must be letters, digits, dots, hyphens or underscores.");
    if (seen.has(name)) return bad("its name is used twice.");
    seen.add(name);
    const purpose = purposeOf(r["purpose"]);
    if (!purpose) return bad(`its purpose must be one of ${CONSENT_PURPOSES.join(", ")}.`);
    const why = text(r["why"], 200);
    if (why === null) return bad("it needs a plain-words reason of at most 200 characters.");
    const cookie: PluginCookie = { name, purpose, why };
    if (r["keptFor"] !== undefined) {
      const kept = text(r["keptFor"], 40);
      if (kept === null) return bad("keptFor must be at most 40 characters.");
      cookie.keptFor = kept;
    }
    out.push(cookie);
  }
  return out;
}

/** The outside addresses a manifest declares, or the words for what is wrong with them. */
export function readOutsideHosts(value: unknown): PluginOutsideHost[] | string {
  if (!Array.isArray(value)) return "The plugin's outsideHosts must be a list.";
  if (value.length > CONSENT_MOST) return "The plugin declares too many outside addresses.";
  const out: PluginOutsideHost[] = [];
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const bad = (why: string) =>
      `The outside address "${String(r["host"] ?? "").slice(0, 40)}" is not valid: ${why}`;
    const host = r["host"];
    if (typeof host !== "string" || !HOST.test(host))
      return bad("it must be a host name such as maps.example.com, in lower case.");
    if (seen.has(host)) return bad("it is listed twice.");
    seen.add(host);
    const purpose = purposeOf(r["purpose"]);
    if (!purpose) return bad(`its purpose must be one of ${CONSENT_PURPOSES.join(", ")}.`);
    const why = text(r["why"], 200);
    if (why === null) return bad("it needs a plain-words reason of at most 200 characters.");
    out.push({ host, purpose, why });
  }
  return out;
}

/** True when anything in the lists needs the visitor's consent first. */
export function needsConsent(cookies: PluginCookie[], hosts: PluginOutsideHost[]): boolean {
  return (
    cookies.some((c) => c.purpose !== "essential") || hosts.some((h) => h.purpose !== "essential")
  );
}
