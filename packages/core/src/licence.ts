// Licence keys for paid plug-ins and themes (ADR 0037, D103; ADR 0027 for the signed token). A key is a signed token that
// a site checks by itself, with no network. One key system for plug-ins and themes.
//
//   OKS1.<payload>.<signature>     payload: JSON in base64url; signature: Ed25519 over "OKS1.<payload>"
//
// A key answers: what it covers, how many sites, how long updates come, and what kind it is (normal, trial, development).
// When a key ends the item keeps working; only updates (and, for a trial, the paid features) stop. Added fields are
// ignored by older code, so new key types can be added later without breaking keys already sold.
import { createPublicKey, sign as edSign, verify as edVerify, createPrivateKey } from "node:crypto";
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const LICENCES_KEY = "licences";
export const LICENCE_PREFIX = "OKS1";
/** At most this many keys on one site. */
export const MAX_LICENCES = 50;

/**
 * The public keys built in: the current one and the next one (ADR 0039), as base64 of the SPKI form. Empty until the
 * founder makes the signing key; until then no key verifies. A site owner may add test keys through the environment
 * (see `publicKeysFromEnv` in the package), never through the admin.
 */
export const LICENCE_PUBLIC_KEYS: string[] = [];

export type LicenceKind = "normal" | "trial" | "development";

export interface LicencePayload {
  /** The format version of the payload. */
  v: 1;
  /** A unique id of this key (also its name in the admin). */
  id: string;
  kind: LicenceKind;
  /** The keys of the plug-ins and themes it covers; `["*"]` covers all of them. */
  covers: string[];
  /** How many sites it is sold for. Always a count, never "unlimited". Offline it is honest use, not enforced. */
  sites: number;
  /**
   * The last day (YYYY-MM-DD, UTC) that updates come, or null for none. Yearly keys and trials have a date. A lifetime
   * key has null and a `maxMajor`.
   */
  updatesUntil: string | null;
  /** Lifetime for this major version and the ones before it: updates of a later major version need an upgrade key. */
  maxMajor: number | null;
  /** The day it was made (YYYY-MM-DD). */
  issued: string;
  /** Who it is for, shown in the admin (optional). */
  holder?: string;
}

export type LicenceRead =
  { ok: true; licence: LicencePayload; token: string } | { ok: false; reason: string };

const b64u = (buffer: Buffer): string => buffer.toString("base64url");

/** Makes a key. For the offline signing tool and for tests; the private key never belongs on a site. */
export function signLicence(payload: LicencePayload, privateKeyPkcs8Base64: string): string {
  const body = `${LICENCE_PREFIX}.${b64u(Buffer.from(JSON.stringify(payload), "utf8"))}`;
  const key = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8Base64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return `${body}.${b64u(edSign(null, Buffer.from(body, "utf8"), key))}`;
}

const isDay = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value));

/** Checks the signature against the built-in public keys, and the shape of the payload. Anything else is refused. */
export function readLicence(token: unknown, publicKeys: readonly string[]): LicenceRead {
  if (typeof token !== "string") return { ok: false, reason: "The key must be text." };
  const text = token.trim();
  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== LICENCE_PREFIX)
    return { ok: false, reason: "This is not a licence key." };
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
  if (!signed) return { ok: false, reason: "This key was not made by us, or it was changed." };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return { ok: false, reason: "The key could not be read." };
  }
  const kind = raw["kind"];
  const covers = raw["covers"];
  const sites = raw["sites"];
  const id = raw["id"];
  if (
    raw["v"] !== 1 ||
    typeof id !== "string" ||
    id === "" ||
    id.length > 80 ||
    (kind !== "normal" && kind !== "trial" && kind !== "development") ||
    !Array.isArray(covers) ||
    covers.length === 0 ||
    covers.length > 100 ||
    !covers.every((c) => typeof c === "string" && c !== "") ||
    typeof sites !== "number" ||
    !Number.isInteger(sites) ||
    sites < 1 ||
    !isDay(raw["issued"]) ||
    (raw["updatesUntil"] !== null && !isDay(raw["updatesUntil"])) ||
    (raw["maxMajor"] !== null &&
      !(Number.isInteger(raw["maxMajor"]) && (raw["maxMajor"] as number) >= 1))
  )
    return { ok: false, reason: "The key is not complete." };
  const licence: LicencePayload = {
    v: 1,
    id,
    kind,
    covers: covers as string[],
    sites,
    updatesUntil: raw["updatesUntil"] as string | null,
    maxMajor: raw["maxMajor"] as number | null,
    issued: raw["issued"] as string,
    ...(typeof raw["holder"] === "string" ? { holder: raw["holder"].slice(0, 80) } : {}),
  };
  return { ok: true, licence, token: text };
}

export type LicenceStatus =
  "active" | "updates-ended" | "trial-ended" | "not-for-this-item" | "wrong-address";

export interface LicenceState {
  status: LicenceStatus;
  /** New versions may be installed. */
  updates: boolean;
  /** The paid features run. False only for a trial that has ended: a plug-in or theme with a normal key keeps working. */
  paidFeatures: boolean;
  /** A short sentence in plain words for the admin. */
  message: string;
}

const endOfDay = (day: string): number => Date.parse(day) + 24 * 3600 * 1000 - 1;

/** A development key works on this machine's own addresses only. */
export const isDevelopmentHost = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host.endsWith(".test") ||
  host === "127.0.0.1" ||
  host === "[::1]";

/**
 * What a key lets a site do with one plug-in or theme. Never a lock-out of something that already works: an ended
 * yearly key or a lifetime key past its major version only stops updates.
 * `version` is the version the site wants to install or runs, such as "2.1.0" (for the major-version rule).
 */
export function licenceState(
  licence: LicencePayload,
  context: { item: string; host: string; now: Date; version?: string },
): LicenceState {
  const covered = licence.covers.includes("*") || licence.covers.includes(context.item);
  if (!covered)
    return {
      status: "not-for-this-item",
      updates: false,
      paidFeatures: false,
      message: `This key does not cover ${context.item}.`,
    };
  if (licence.kind === "development" && !isDevelopmentHost(context.host))
    return {
      status: "wrong-address",
      updates: false,
      paidFeatures: false,
      message: "A development key works only on localhost and .test addresses.",
    };
  const now = context.now.getTime();
  if (licence.kind === "trial") {
    const over = licence.updatesUntil !== null && now > endOfDay(licence.updatesUntil);
    return over
      ? {
          status: "trial-ended",
          updates: false,
          paidFeatures: false,
          message: "The trial has ended. Buy a key to go on using the paid features.",
        }
      : {
          status: "active",
          updates: true,
          paidFeatures: true,
          message: `Trial until ${licence.updatesUntil ?? "further notice"}.`,
        };
  }
  const major = context.version ? Number.parseInt(context.version, 10) : null;
  if (
    licence.updatesUntil === null &&
    licence.maxMajor !== null &&
    major !== null &&
    major > licence.maxMajor
  )
    return {
      status: "updates-ended",
      updates: false,
      paidFeatures: true,
      message: `Lifetime for version ${licence.maxMajor}. Version ${major} needs an upgrade key. It keeps working.`,
    };
  if (licence.updatesUntil !== null && now > endOfDay(licence.updatesUntil))
    return {
      status: "updates-ended",
      updates: false,
      paidFeatures: true,
      message: `Updates ended on ${licence.updatesUntil}. It keeps working; renew to get updates.`,
    };
  return {
    status: "active",
    updates: true,
    paidFeatures: true,
    message:
      licence.updatesUntil === null
        ? "Lifetime key: updates have no end date for this version."
        : `Updates until ${licence.updatesUntil}.`,
  };
}

/** The best state among a site's keys for one item: a key with updates beats one without. */
export function bestLicenceState(
  licences: readonly LicencePayload[],
  context: { item: string; host: string; now: Date; version?: string },
): LicenceState | null {
  const rank = (s: LicenceState) =>
    (s.updates ? 4 : 0) + (s.paidFeatures ? 2 : 0) + (s.status !== "not-for-this-item" ? 1 : 0);
  let best: LicenceState | null = null;
  for (const licence of licences) {
    const state = licenceState(licence, context);
    if (!best || rank(state) > rank(best)) best = state;
  }
  return best;
}

// ---- the keys of a site, kept in the `settings` table under "licences" ----

export type LicenceResult<T> =
  ({ ok: true } & T) | { ok: false; code: "forbidden" | "invalid" | "not-found"; message: string };

async function savedTokens(runner: SqlRunner, siteId: string): Promise<string[]> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, LICENCES_KEY],
  );
  let value: unknown = rows[0]?.["value"];
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const keys = (value as { keys?: unknown } | null)?.keys;
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
}

async function writeTokens(runner: SqlRunner, siteId: string, keys: string[]): Promise<void> {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, LICENCES_KEY, JSON.stringify({ keys }), new Date()],
  );
}

/** The keys of the site that still verify (a key whose signing key was taken out is dropped from the list shown). */
export async function listLicences(
  runner: SqlRunner,
  siteId: string,
  publicKeys: readonly string[],
): Promise<LicencePayload[]> {
  const found: LicencePayload[] = [];
  for (const token of await savedTokens(runner, siteId)) {
    const read = readLicence(token, publicKeys);
    if (read.ok) found.push(read.licence);
  }
  return found;
}

/** Adds a key. Only people who manage the settings can; a key that does not verify is refused with the reason. */
export async function addLicence(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  token: unknown,
  publicKeys: readonly string[],
): Promise<LicenceResult<{ licence: LicencePayload }>> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the licence keys." };
  const read = readLicence(token, publicKeys);
  if (!read.ok) return { ok: false, code: "invalid", message: read.reason };
  const tokens = await savedTokens(runner, siteId);
  const ids = new Set(
    tokens.flatMap((t) => {
      const r = readLicence(t, publicKeys);
      return r.ok ? [r.licence.id] : [];
    }),
  );
  if (ids.has(read.licence.id))
    return { ok: false, code: "invalid", message: "This key is already added." };
  if (tokens.length >= MAX_LICENCES)
    return { ok: false, code: "invalid", message: `At most ${MAX_LICENCES} keys can be added.` };
  await writeTokens(runner, siteId, [...tokens, read.token]);
  return { ok: true, licence: read.licence };
}

/** Removes a key by its id. */
export async function removeLicence(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
  publicKeys: readonly string[],
): Promise<LicenceResult<object>> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the licence keys." };
  const tokens = await savedTokens(runner, siteId);
  const kept = tokens.filter((t) => {
    const r = readLicence(t, publicKeys);
    return !(r.ok && r.licence.id === id);
  });
  if (kept.length === tokens.length)
    return { ok: false, code: "not-found", message: "There is no such key." };
  await writeTokens(runner, siteId, kept);
  return { ok: true };
}
