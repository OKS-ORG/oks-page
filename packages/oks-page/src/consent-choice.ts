// What the consent notice remembers in the visitor's browser (spec 18, section 2): the accepted purposes, the notice version
// and when. A choice is used only while it is younger than six months and was made for the same version of the notice, so
// a new purpose asks again. Plain functions, so they can be tested without a browser.
export const STORE_KEY = "oks-consent";
export const REMEMBER_MS = 183 * 24 * 60 * 60 * 1000;

export interface StoredChoice {
  accepted: string[];
  version: string;
  at: number;
}

/** The remembered choice, or null when there is none, it is too old, or it was made for another version of the notice. */
export function readChoice(raw: string | null, version: string, now: number): StoredChoice | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredChoice> | null;
    if (!v || typeof v !== "object") return null;
    if (!Array.isArray(v.accepted) || !v.accepted.every((p) => typeof p === "string")) return null;
    if (typeof v.version !== "string" || v.version !== version) return null;
    if (typeof v.at !== "number" || v.at > now || now - v.at >= REMEMBER_MS) return null;
    return { accepted: v.accepted, version: v.version, at: v.at };
  } catch {
    return null;
  }
}

export function writeChoice(accepted: string[], version: string, now: number): string {
  return JSON.stringify({ accepted, version, at: now } satisfies StoredChoice);
}
