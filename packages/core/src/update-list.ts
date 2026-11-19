// The signed update list (spec 14, section 3; ADR 0039). We publish one list of the newest versions, versions marked
// unsafe and security warnings, signed with our key. A site checks the signature itself, with the public keys built in
// (the current one and the next one), refuses a list older than the one it already holds, and notes a list that is
// more than 7 days old. Fetching the list, the schedule and the Updates screen are separate pieces; this is the part
// that decides whether a list can be believed.
//
//   OKU1.<payload>.<signature>     payload: JSON in base64url; signature: Ed25519 over "OKU1.<payload>"
//
// The prefix differs from a licence key's (OKS1), so a signature made for one can never pass for the other.
import { createPublicKey, verify as edVerify } from "node:crypto";

export const UPDATE_LIST_PREFIX = "OKU1";
/** A list older than this is "too old": Site health warns (UP-04). */
export const UPDATE_LIST_MAX_AGE_DAYS = 7;

/**
 * The public keys built in, as base64 of the SPKI form: the current one and the next one (ADR 0039). Empty until the
 * founder makes the signing key; until then no list is believed. A test may pass its own keys to the reading function; no site owner can add one
 * (never through the admin).
 */
export const UPDATE_PUBLIC_KEYS: string[] = [];

export type Severity = "low" | "medium" | "high" | "critical";
const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];

export interface UpdateItem {
  /** The key of a plug-in or theme in the marketplace. */
  key: string;
  kind: "plugin" | "theme";
  latest: string;
  /** Versions that must not run (spec 04): the site switches the item off until it is fixed. */
  unsafe: string[];
}

export interface SecurityWarning {
  id: string;
  /** "core", or the key of a plug-in or theme. */
  affects: string;
  /** The versions that are affected, such as "<1.4.3" or "1.2.0". Read by the code that compares versions. */
  versions: string;
  fixed: string;
  severity: Severity;
  summary: string;
  link: string;
}

export interface UpdateList {
  v: 1;
  /** Rises with every list; a site refuses one lower than the one it holds (UP-03). */
  seq: number;
  /** When the list was made (ISO date and time). */
  issued: string;
  /** The newest core version for each supported major version, such as { "1": "1.4.3" }. */
  core: Record<string, string>;
  items: UpdateItem[];
  warnings: SecurityWarning[];
}

export type UpdateListRead = { ok: true; list: UpdateList } | { ok: false; reason: string };

const isText = (value: unknown, max = 500): value is string =>
  typeof value === "string" && value !== "" && value.length <= max;
const isVersion = (value: unknown): value is string =>
  typeof value === "string" && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(value);
const isHttps = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** The shape of a list, or what is wrong with it. Used when reading one and by the signing tool. */
export function checkUpdateList(raw: unknown): UpdateListRead {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o || o["v"] !== 1)
    return { ok: false, reason: "The list is not in a format this site knows." };
  const seq = o["seq"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1)
    return { ok: false, reason: "The list has no sequence number." };
  const issued = o["issued"];
  if (typeof issued !== "string" || Number.isNaN(Date.parse(issued)))
    return { ok: false, reason: "The list has no date." };
  const core = o["core"];
  if (!core || typeof core !== "object" || Array.isArray(core))
    return { ok: false, reason: "The list has no core versions." };
  const coreVersions: Record<string, string> = {};
  for (const [major, version] of Object.entries(core as Record<string, unknown>)) {
    if (!/^\d+$/.test(major) || !isVersion(version) || !version.startsWith(`${major}.`))
      return { ok: false, reason: `The core version for ${major} is not valid.` };
    coreVersions[major] = version;
  }
  if (!Array.isArray(o["items"]) || o["items"].length > 5000)
    return { ok: false, reason: "The list of plug-ins and themes is not valid." };
  const items: UpdateItem[] = [];
  for (const item of o["items"] as unknown[]) {
    const i = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const unsafe = i["unsafe"] ?? [];
    if (
      !isText(i["key"], 100) ||
      (i["kind"] !== "plugin" && i["kind"] !== "theme") ||
      !isVersion(i["latest"]) ||
      !Array.isArray(unsafe) ||
      !unsafe.every(isVersion)
    )
      return { ok: false, reason: "An entry of the list is not valid." };
    items.push({ key: i["key"], kind: i["kind"], latest: i["latest"], unsafe: unsafe as string[] });
  }
  const rawWarnings = o["warnings"] ?? [];
  if (!Array.isArray(rawWarnings) || rawWarnings.length > 1000)
    return { ok: false, reason: "The security warnings are not valid." };
  const warnings: SecurityWarning[] = [];
  for (const warning of rawWarnings as unknown[]) {
    const w = warning && typeof warning === "object" ? (warning as Record<string, unknown>) : {};
    if (
      !isText(w["id"], 100) ||
      !isText(w["affects"], 100) ||
      !isText(w["versions"], 100) ||
      !isVersion(w["fixed"]) ||
      !SEVERITIES.includes(w["severity"] as Severity) ||
      !isText(w["summary"], 500) ||
      !isHttps(w["link"])
    )
      return { ok: false, reason: "A security warning is not valid." };
    warnings.push({
      id: w["id"],
      affects: w["affects"],
      versions: w["versions"],
      fixed: w["fixed"],
      severity: w["severity"] as Severity,
      summary: w["summary"],
      link: w["link"],
    });
  }
  return {
    ok: true,
    list: {
      v: 1,
      seq,
      issued: new Date(issued).toISOString(),
      core: coreVersions,
      items,
      warnings,
    },
  };
}

/** Checks the signature against the built-in public keys (any of them), then the shape. Anything else is refused. */
export function readUpdateList(token: unknown, publicKeys: readonly string[]): UpdateListRead {
  if (typeof token !== "string") return { ok: false, reason: "The list must be text." };
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== UPDATE_LIST_PREFIX)
    return { ok: false, reason: "This is not an update list." };
  const body = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2]!, "base64url");
  const signed = publicKeys.some((publicKey) => {
    try {
      return edVerify(
        null,
        Buffer.from(body, "utf8"),
        createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }),
        signature,
      );
    } catch {
      return false;
    }
  });
  if (!signed) return { ok: false, reason: "This list was not signed by us, or it was changed." };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "The list could not be read." };
  }
  return checkUpdateList(raw);
}

/**
 * Whether a list may replace the one the site holds: the same one is fine, a lower sequence number is refused so an old
 * list that hides a warning cannot be played again (UP-03).
 */
export function mayReplaceList(held: { seq: number } | null, next: { seq: number }): boolean {
  return held === null || next.seq >= held.seq;
}

/** True when the list is more than 7 days old (UP-04). */
export function updateListStale(list: { issued: string }, now: Date): boolean {
  return now.getTime() - Date.parse(list.issued) > UPDATE_LIST_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}
