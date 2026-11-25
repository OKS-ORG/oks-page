// The connector (spec 11, section 6; AG-01 to AG-15): how a client site answers the agency's dashboard. It is a short, fixed list
// of things: report the site's status, report page and visit counts, and (not built yet) start a backup or apply an update. It
// can never read content, users or secrets.
//
// Every request is signed with HMAC-SHA-256 over: the method, the address with its query, the time, a one-time number (nonce) and a
// hash of the body. The site shows a connection code once (its address, a key id and a secret of 32 random bytes); the agency
// pastes it into the dashboard. A site may hold several keys at once, to change a key without a break (add the new one, switch
// the dashboard, remove the old one).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SqlRunner } from "@oks-page/db";
import { newId } from "@oks-page/db";
import type { Actor } from "./content.js";
import type { SiteSecrets } from "./secret-box.js";
import { loadStatistics } from "./statistics.js";

export const CONNECTOR_KEY = "connector";
export const CODE_PREFIX = "OKSC1";
export const MAX_KEYS = 5;
/** A request may be this far from the site's own clock, in either direction. */
export const CLOCK_WINDOW_MS = 5 * 60 * 1000;
/** A used nonce is remembered this long (a request older than the window is refused anyway). */
export const NONCE_KEEP_MS = 10 * 60 * 1000;
export const BODY_MAX_BYTES = 64 * 1024;

const LABEL = "OKS-CONNECT-1";
const sha256hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

export interface SignedHeaders {
  "x-oks-key": string;
  "x-oks-time": string;
  "x-oks-nonce": string;
  "x-oks-signature": string;
}

const canonical = (
  method: string,
  target: string,
  time: string,
  nonce: string,
  bodyHash: string,
): string => [LABEL, method.toUpperCase(), target, time, nonce, bodyHash].join("\n");

/** What the dashboard adds to a request: the key id, the time, a fresh nonce and the signature. */
export function signRequest(input: {
  method: string;
  /** The path and query as sent, such as "/api/oks/v1/status?x=1". */
  target: string;
  body?: Uint8Array | string;
  keyId: string;
  secret: string;
  now: number;
  nonce?: string;
}): SignedHeaders {
  const nonce = input.nonce ?? randomBytes(18).toString("base64url");
  const time = String(input.now);
  const signature = createHmac("sha256", Buffer.from(input.secret, "base64url"))
    .update(canonical(input.method, input.target, time, nonce, sha256hex(input.body ?? "")))
    .digest("hex");
  return {
    "x-oks-key": input.keyId,
    "x-oks-time": time,
    "x-oks-nonce": nonce,
    "x-oks-signature": signature,
  };
}

/** Remembers the nonces used lately, so a request cannot be sent twice. In one process only (see the spec's open item 2). */
export class NonceStore {
  private readonly seen = new Map<string, number>();
  /** False when the nonce was used already; otherwise it is remembered. Old nonces are dropped as it goes. */
  use(nonce: string, now: number): boolean {
    for (const [n, at] of this.seen) {
      if (now - at <= NONCE_KEEP_MS) break; // the map is in the order the nonces came
      this.seen.delete(n);
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }
  get size(): number {
    return this.seen.size;
  }
}

export type VerifyResult =
  | { ok: true; keyId: string }
  | {
      ok: false;
      status: 401 | 413;
      code: "unsigned" | "bad_signature" | "clock" | "replayed" | "too_large";
      message: string;
    };

const NOT_SIGNED = "The request is not signed correctly.";

/** Checks a request on the site's side. Nothing is answered for a request that fails any step. */
export function verifyRequest(input: {
  method: string;
  target: string;
  headers: (name: string) => string | null | undefined;
  body: Uint8Array;
  keys: { id: string; secret: string }[];
  nonces: NonceStore;
  now: number;
}): VerifyResult {
  if (input.body.length > BODY_MAX_BYTES)
    return { ok: false, status: 413, code: "too_large", message: "The request is too large." };
  const keyId = input.headers("x-oks-key") ?? "";
  const time = input.headers("x-oks-time") ?? "";
  const nonce = input.headers("x-oks-nonce") ?? "";
  const given = input.headers("x-oks-signature") ?? "";
  if (!keyId || !time || !nonce || !given)
    return { ok: false, status: 401, code: "unsigned", message: NOT_SIGNED };
  if (
    !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) ||
    !/^\d{10,16}$/.test(time) ||
    !/^[0-9a-f]{64}$/.test(given)
  )
    return { ok: false, status: 401, code: "bad_signature", message: NOT_SIGNED };
  const key = input.keys.find((k) => k.id === keyId);
  // An unknown key is checked against a made-up secret, so it takes as long as a known one.
  const secret = key?.secret ?? randomBytes(32).toString("base64url");
  const expected = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(canonical(input.method, input.target, time, nonce, sha256hex(input.body)))
    .digest();
  const same = timingSafeEqual(expected, Buffer.from(given, "hex"));
  if (!key || !same) return { ok: false, status: 401, code: "bad_signature", message: NOT_SIGNED };
  // Only a caller who holds a key is told about the clock.
  if (Math.abs(input.now - Number(time)) > CLOCK_WINDOW_MS)
    return {
      ok: false,
      status: 401,
      code: "clock",
      message:
        "The time of this request is more than 5 minutes away from this site's clock. Check the time of both servers.",
    };
  if (!input.nonces.use(nonce, input.now))
    return { ok: false, status: 401, code: "replayed", message: "This request was already used." };
  return { ok: true, keyId };
}

// ---------------------------------------------------------------------------------------------------------- the site's keys

interface StoredKey {
  id: string;
  sealed: string;
  createdAt: number;
}

const place = (id: string) => `connector:${id}`;
const parse = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

async function storedKeys(runner: SqlRunner, siteId: string): Promise<StoredKey[]> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, CONNECTOR_KEY],
  );
  const value = parse(runner, rows[0]?.["value"]) as { keys?: unknown } | null;
  return (Array.isArray(value?.keys) ? value.keys : []).filter(
    (k): k is StoredKey =>
      typeof k === "object" &&
      k !== null &&
      typeof (k as StoredKey).id === "string" &&
      typeof (k as StoredKey).sealed === "string",
  );
}

async function saveKeys(runner: SqlRunner, siteId: string, keys: StoredKey[]): Promise<void> {
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, CONNECTOR_KEY, JSON.stringify({ keys }), new Date()],
  );
}

/** The keys with their secrets, to check a request. Never shown to anyone. */
export async function connectorKeys(
  runner: SqlRunner,
  siteId: string,
  secrets: SiteSecrets,
): Promise<{ id: string; secret: string }[]> {
  const out: { id: string; secret: string }[] = [];
  for (const k of await storedKeys(runner, siteId)) {
    try {
      out.push({ id: k.id, secret: secrets.open(k.sealed, place(k.id)) });
    } catch {
      // A key that cannot be opened (the site's secret changed) is not valid.
    }
  }
  return out;
}

export interface ConnectorKeyView {
  id: string;
  createdAt: number;
}

type Fail = { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };

export async function listConnectorKeys(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
): Promise<ConnectorKeyView[]> {
  if (!actor.can("settings.manage")) return [];
  return (await storedKeys(runner, siteId)).map((k) => ({ id: k.id, createdAt: k.createdAt }));
}

/** The text an agency pastes into its dashboard. */
export function connectionCode(url: string, keyId: string, secret: string): string {
  return `${CODE_PREFIX}.${Buffer.from(JSON.stringify({ v: 1, url, key: keyId, secret })).toString("base64url")}`;
}

export type ParsedCode =
  { ok: true; url: string; keyId: string; secret: string } | { ok: false; message: string };

export function parseConnectionCode(code: unknown): ParsedCode {
  const bad = { ok: false as const, message: "This is not a connection code." };
  if (typeof code !== "string") return bad;
  const parts = code.trim().split(".");
  if (parts.length !== 2 || parts[0] !== CODE_PREFIX || parts[1]!.length > 2000) return bad;
  try {
    const v = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      v["v"] !== 1 ||
      typeof v["url"] !== "string" ||
      typeof v["key"] !== "string" ||
      typeof v["secret"] !== "string" ||
      !/^[A-Za-z0-9_-]{3,64}$/.test(v["key"]) ||
      Buffer.from(v["secret"], "base64url").length < 32
    )
      return bad;
    return { ok: true, url: v["url"], keyId: v["key"], secret: v["secret"] };
  } catch {
    return bad;
  }
}

/** Makes a key and returns the connection code, once: only the sealed secret is kept. */
export async function addConnectorKey(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  siteUrl: string,
  now: () => number = Date.now,
): Promise<{ ok: true; id: string; code: string } | Fail> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not change the connection.");
  const keys = await storedKeys(runner, siteId);
  if (keys.length >= MAX_KEYS)
    return fail("invalid", `A site can have ${MAX_KEYS} keys at most. Remove one first.`);
  const id = `k${newId().slice(-12).toLowerCase()}`;
  const secret = randomBytes(32).toString("base64url");
  keys.push({ id, sealed: secrets.seal(secret, place(id)), createdAt: now() });
  await saveKeys(runner, siteId, keys);
  return { ok: true, id, code: connectionCode(siteUrl, id, secret) };
}

export async function removeConnectorKey(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  id: string,
): Promise<{ ok: true } | Fail> {
  if (!actor.can("settings.manage")) return fail("forbidden", "You may not change the connection.");
  const keys = await storedKeys(runner, siteId);
  if (!keys.some((k) => k.id === id)) return fail("not_found", "This key does not exist.");
  await saveKeys(
    runner,
    siteId,
    keys.filter((k) => k.id !== id),
  );
  return { ok: true };
}

const fail = (code: Fail["code"], message: string): Fail => ({ ok: false, code, message });

// ----------------------------------------------------------------------------------------------------------- what it answers

export interface ConnectorFacts {
  version: string;
  twoFactor: { on: number; total: number };
  emailWorks: boolean;
  privacyPage: boolean;
  /** Free disk space where the site keeps its files, or null when this server cannot tell. */
  diskFreeBytes: number | null;
  /** When the newest backup that passed its check was made, or null when there is none. */
  lastBackupAt: number | null;
}

export interface ConnectorStatus {
  version: string;
  siteName: string;
  /** What the dashboard may know about updates: this site does not check for them yet, so the count is unknown. */
  pendingUpdates: number | null;
  /** When the newest backup that passed its check was made, or null when there is none. */
  lastBackupAt: number | null;
  diskFreeBytes: number | null;
  checks: { id: string; label: string; ok: boolean }[];
  at: number;
}

export async function connectorStatus(
  runner: SqlRunner,
  siteId: string,
  facts: ConnectorFacts,
  now: number,
): Promise<ConnectorStatus> {
  const site = await runner.all(`select "name" from "sites" where "id" = ?`, [siteId]);
  const { on, total } = facts.twoFactor;
  return {
    version: facts.version,
    siteName: String(site[0]?.["name"] ?? ""),
    pendingUpdates: null,
    lastBackupAt: facts.lastBackupAt,
    diskFreeBytes: facts.diskFreeBytes,
    checks: [
      { id: "database", label: "The database answers", ok: true },
      {
        id: "two-factor",
        label: "Administrators use two-factor sign-in",
        ok: total > 0 && on === total,
      },
      { id: "email", label: "Email is set up", ok: facts.emailWorks },
      { id: "privacy", label: "A privacy page is chosen", ok: facts.privacyPage },
      {
        id: "backup",
        label: "A backup was made in the last two days",
        ok: facts.lastBackupAt !== null && now - facts.lastBackupAt <= 48 * 60 * 60 * 1000,
      },
    ],
    at: now,
  };
}

export interface ConnectorReport {
  days: number;
  views: number;
  visitors: number;
  publishedPages: number;
  topPages: { key: string; count: number }[];
  perDay: { day: string; views: number; visitors: number }[];
}

/** Page and visit counts from the privacy-friendly statistics. No content, no visitors, no people. */
export async function connectorReport(
  runner: SqlRunner,
  siteId: string,
  now: number,
  days = 30,
): Promise<ConnectorReport> {
  const stats = await loadStatistics(runner, siteId, days, now);
  const pages = await runner.all(
    `select count(*) as n from "entries" where "site_id" = ? and "status" = 'published'`,
    [siteId],
  );
  return {
    days,
    views: stats.views,
    visitors: stats.visitors,
    publishedPages: Number(pages[0]?.["n"] ?? 0),
    topPages: stats.pages.slice(0, 5),
    perDay: stats.days,
  };
}
