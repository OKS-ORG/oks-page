// The connector (spec 11, section 6; AG-01 to AG-15): signed requests, what is refused and why, the site's keys and the
// connection code, and what the site answers. Signing and checking are pure, so most cases need no database; the keys and the
// answers run on SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addConnectorKey,
  BODY_MAX_BYTES,
  CLOCK_WINDOW_MS,
  connectionCode,
  connectorKeys,
  connectorReport,
  connectorStatus,
  listConnectorKeys,
  NONCE_KEEP_MS,
  NonceStore,
  parseConnectionCode,
  removeConnectorKey,
  signRequest,
  verifyRequest,
} from "./connector.js";
import type { Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
import { runSetup } from "./setup.js";

const T = 1_700_000_000_000;
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const OTHER = Buffer.alloc(32, 9).toString("base64url");
const KEYS = [{ id: "key-one", secret: SECRET }];

const send = (
  over: Partial<{
    method: string;
    target: string;
    body: string;
    keyId: string;
    secret: string;
    now: number;
    nonce: string;
  }> = {},
) => {
  const base = {
    method: "GET",
    target: "/api/oks/v1/status",
    body: "",
    keyId: "key-one",
    secret: SECRET,
    now: T,
    ...over,
  };
  return { ...base, headers: signRequest(base) };
};
const check = (
  sent: ReturnType<typeof send>,
  over: {
    method?: string;
    target?: string;
    body?: string | Uint8Array;
    now?: number;
    nonces?: NonceStore;
    keys?: { id: string; secret: string }[];
    drop?: string;
  } = {},
) => {
  const headers = { ...sent.headers } as Record<string, string>;
  if (over.drop) delete headers[over.drop];
  const body = over.body ?? sent.body;
  return verifyRequest({
    method: over.method ?? sent.method,
    target: over.target ?? sent.target,
    headers: (n) => headers[n],
    body: typeof body === "string" ? new TextEncoder().encode(body) : body,
    keys: over.keys ?? KEYS,
    nonces: over.nonces ?? new NonceStore(),
    now: over.now ?? T,
  });
};

describe("signed requests (AG-01 to AG-09)", () => {
  test("a correct signed GET and POST are answered", () => {
    expect(check(send())).toEqual({ ok: true, keyId: "key-one" });
    const post = send({ method: "POST", target: "/api/oks/v1/backup", body: '{"a":1}' });
    expect(check(post)).toEqual({ ok: true, keyId: "key-one" });
  });

  test("the same request sent twice is refused the second time (AG-02)", () => {
    const nonces = new NonceStore();
    const sent = send();
    expect(check(sent, { nonces }).ok).toBe(true);
    expect(check(sent, { nonces })).toMatchObject({ ok: false, status: 401, code: "replayed" });
  });

  test("a wrong secret, an unknown key and a missing signature are refused with 401 (AG-03)", () => {
    for (const result of [
      check(send({ secret: OTHER })),
      check(send({ keyId: "no-such-key" })),
      check(send(), { drop: "x-oks-signature" }),
      check(send(), { drop: "x-oks-key" }),
      check(send(), { drop: "x-oks-nonce" }),
      check(send(), { drop: "x-oks-time" }),
    ])
      expect(result).toMatchObject({ ok: false, status: 401 });
    // Nothing tells a stranger which of the reasons it was.
    expect(check(send({ secret: OTHER }))).toMatchObject({
      message: "The request is not signed correctly.",
    });
    expect(check(send({ keyId: "no-such-key" }))).toMatchObject({
      message: "The request is not signed correctly.",
    });
  });

  test("a body, address, query or method changed after signing is refused (AG-04, AG-05)", () => {
    const post = send({ method: "POST", target: "/api/oks/v1/backup?x=1", body: '{"a":1}' });
    expect(check(post, { body: '{"a":2}' })).toMatchObject({ ok: false, code: "bad_signature" });
    expect(check(post, { target: "/api/oks/v1/update?x=1" })).toMatchObject({
      ok: false,
      code: "bad_signature",
    });
    expect(check(post, { target: "/api/oks/v1/backup?x=2" })).toMatchObject({
      ok: false,
      code: "bad_signature",
    });
    expect(check(post, { target: "/api/oks/v1/backup" })).toMatchObject({
      ok: false,
      code: "bad_signature",
    });
    // A signed GET replayed as a POST.
    expect(check(send(), { method: "POST" })).toMatchObject({ ok: false, code: "bad_signature" });
  });

  test("a request more than 5 minutes old or from the future is refused, with a message about the clock (AG-06)", () => {
    const sent = send();
    for (const now of [T + CLOCK_WINDOW_MS + 1, T - CLOCK_WINDOW_MS - 1]) {
      const r = check(sent, { now });
      expect(r).toMatchObject({
        ok: false,
        status: 401,
        code: "clock",
        message: expect.stringMatching(/5 minutes.*clock/),
      });
    }
    expect(check(sent, { now: T + CLOCK_WINDOW_MS }).ok).toBe(true);
    // A refused request does not use up its nonce, and only someone with a key is told about the clock.
    expect(check(send({ secret: OTHER }), { now: T + CLOCK_WINDOW_MS + 1 })).toMatchObject({
      code: "bad_signature",
    });
  });

  test("a body over 64 KB is refused with 413 (AG-07)", () => {
    const big = new Uint8Array(BODY_MAX_BYTES + 1);
    expect(check(send({ method: "POST" }), { body: big })).toMatchObject({
      ok: false,
      status: 413,
      code: "too_large",
    });
    expect(check(send({ method: "POST", body: "x".repeat(BODY_MAX_BYTES) })).ok).toBe(true);
  });

  test("two keys are valid at the same time, so a key can be changed without a break (AG-08)", () => {
    const keys = [...KEYS, { id: "key-two", secret: OTHER }];
    expect(check(send(), { keys }).ok).toBe(true);
    expect(check(send({ keyId: "key-two", secret: OTHER }), { keys })).toEqual({
      ok: true,
      keyId: "key-two",
    });
    // After the old key is removed only the new one works.
    expect(check(send(), { keys: [keys[1]!] })).toMatchObject({ ok: false, code: "bad_signature" });
  });

  test("badly formed headers are refused without an error", () => {
    const sent = send();
    for (const headers of [
      { ...sent.headers, "x-oks-signature": "zz" },
      { ...sent.headers, "x-oks-nonce": "short" },
      { ...sent.headers, "x-oks-time": "yesterday" },
      { ...sent.headers, "x-oks-key": "" },
    ]) {
      const r = verifyRequest({
        method: "GET",
        target: sent.target,
        headers: (n) => (headers as Record<string, string>)[n],
        body: new Uint8Array(),
        keys: KEYS,
        nonces: new NonceStore(),
        now: T,
      });
      expect(r).toMatchObject({ ok: false, status: 401 });
    }
  });

  test("2,000 requests in a row do not make the nonce list grow without end (AG-09)", () => {
    const nonces = new NonceStore();
    for (let i = 0; i < 2000; i++) {
      const sent = send({ now: T + i * 1000 });
      const r = check(sent, { nonces, now: T + i * 1000 });
      expect(r.ok, String(i)).toBe(true);
    }
    // Only what was used in the last 10 minutes is remembered.
    expect(nonces.size).toBeLessThanOrEqual(NONCE_KEEP_MS / 1000 + 1);
    expect(nonces.size).toBeGreaterThan(100);
  });
});

describe("the connection code", () => {
  test("a code holds the address, the key and the secret, and comes back whole", () => {
    const code = connectionCode("https://client.example", "key-one", SECRET);
    expect(code.startsWith("OKSC1.")).toBe(true);
    expect(parseConnectionCode(code)).toEqual({
      ok: true,
      url: "https://client.example",
      keyId: "key-one",
      secret: SECRET,
    });
    expect(parseConnectionCode(`  ${code}\n`).ok).toBe(true);
  });

  test("anything else is refused in words, without an error", () => {
    const short = Buffer.alloc(8).toString("base64url");
    for (const bad of [
      undefined,
      "",
      "hello",
      "OKSC1.",
      "OKSC1.!!!",
      "OKS1.abc.def",
      `OKSC1.${Buffer.from("not json").toString("base64url")}`,
      connectionCode("https://x.example", "key-one", short),
      connectionCode("https://x.example", "k", SECRET),
      `OKSC1.${"A".repeat(3000)}`,
    ])
      expect(parseConnectionCode(bad), String(bad).slice(0, 30)).toEqual({
        ok: false,
        message: "This is not a connection code.",
      });
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the site's keys and answers`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let editor: Actor;
    const secrets = new SiteSecrets("s".repeat(40));

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async (input) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, input.name, input.email, new Date(T), new Date(T)],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@garden.test", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      const caps = (role: string) => DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
      anna = { userId: setup.userId, can: (c) => caps("administrator").includes(c) };
      editor = { userId: setup.userId, can: (c) => caps("editor").includes(c) };
    });
    afterEach(async () => db.close());

    test("a key is made once, shown in a code, and kept only sealed (AG-10)", async () => {
      const made = await addConnectorKey(
        db.runner,
        anna,
        siteId,
        secrets,
        "https://client.example",
        () => T,
      );
      if (!made.ok) throw new Error(made.message);
      const parsed = parseConnectionCode(made.code);
      expect(parsed).toMatchObject({ ok: true, url: "https://client.example", keyId: made.id });
      if (!parsed.ok) throw new Error("no code");
      // The database holds the sealed secret, not the secret.
      const stored = JSON.stringify(
        await db.run(`select value from settings where key = 'connector'`),
      );
      expect(stored).not.toContain(parsed.secret);
      expect(await connectorKeys(db.runner, siteId, secrets)).toEqual([
        { id: made.id, secret: parsed.secret },
      ]);
      expect(await listConnectorKeys(db.runner, anna, siteId)).toEqual([
        { id: made.id, createdAt: T },
      ]);
      // A request signed with the code's key passes.
      const sent = signRequest({
        method: "GET",
        target: "/api/oks/v1/status",
        keyId: parsed.keyId,
        secret: parsed.secret,
        now: T,
      });
      expect(
        verifyRequest({
          method: "GET",
          target: "/api/oks/v1/status",
          headers: (n) => (sent as Record<string, string>)[n],
          body: new Uint8Array(),
          keys: await connectorKeys(db.runner, siteId, secrets),
          nonces: new NonceStore(),
          now: T,
        }).ok,
      ).toBe(true);
    });

    test("keys can be changed without a break: add a second, remove the first (AG-08)", async () => {
      const first = await addConnectorKey(
        db.runner,
        anna,
        siteId,
        secrets,
        "https://client.example",
        () => T,
      );
      const second = await addConnectorKey(
        db.runner,
        anna,
        siteId,
        secrets,
        "https://client.example",
        () => T + 1,
      );
      if (!first.ok || !second.ok) throw new Error("keys");
      expect((await connectorKeys(db.runner, siteId, secrets)).map((k) => k.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      expect(await removeConnectorKey(db.runner, anna, siteId, first.id)).toEqual({ ok: true });
      expect((await connectorKeys(db.runner, siteId, secrets)).map((k) => k.id)).toEqual([
        second.id,
      ]);
      expect(await removeConnectorKey(db.runner, anna, siteId, first.id)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });

    test("at most five keys, and only people who manage the site change them", async () => {
      expect(
        await addConnectorKey(db.runner, editor, siteId, secrets, "https://c.example"),
      ).toMatchObject({ ok: false, code: "forbidden" });
      for (let i = 0; i < 5; i++)
        expect(
          (
            await addConnectorKey(
              db.runner,
              anna,
              siteId,
              secrets,
              "https://c.example",
              () => T + i,
            )
          ).ok,
        ).toBe(true);
      expect(
        await addConnectorKey(db.runner, anna, siteId, secrets, "https://c.example"),
      ).toMatchObject({ ok: false, code: "invalid" });
      const [one] = await listConnectorKeys(db.runner, anna, siteId);
      expect(await removeConnectorKey(db.runner, editor, siteId, one!.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await listConnectorKeys(db.runner, editor, siteId)).toEqual([]);
    });

    test("a key sealed with another site secret is not valid", async () => {
      await addConnectorKey(db.runner, anna, siteId, secrets, "https://c.example");
      expect(await connectorKeys(db.runner, siteId, new SiteSecrets("t".repeat(40)))).toEqual([]);
    });

    test("the status holds the version, checks and disk space, and never content or people (AG-11)", async () => {
      const status = await connectorStatus(
        db.runner,
        siteId,
        {
          version: "1.2.3",
          twoFactor: { on: 1, total: 1 },
          emailWorks: false,
          privacyPage: true,
          diskFreeBytes: 5_000_000_000,
        },
        T,
      );
      expect(status).toMatchObject({
        version: "1.2.3",
        siteName: "Anna's Garden",
        pendingUpdates: null,
        lastBackupAt: null,
        diskFreeBytes: 5_000_000_000,
        at: T,
      });
      expect(status.checks.map((c) => [c.id, c.ok])).toEqual([
        ["database", true],
        ["two-factor", true],
        ["email", false],
        ["privacy", true],
      ]);
      const text = JSON.stringify(status);
      expect(text).not.toContain("anna@garden.test");
      expect(text).not.toContain('Anna"');
    });

    test("the report holds counts only", async () => {
      const day = new Date(T).toISOString().slice(0, 10);
      await db.run(
        `insert into stats_daily (site_id, day, kind, key, count) values (?, ?, 'views', '', 12)`,
        [siteId, day],
      );
      await db.run(
        `insert into stats_daily (site_id, day, kind, key, count) values (?, ?, 'visitors', '', 5)`,
        [siteId, day],
      );
      await db.run(
        `insert into stats_daily (site_id, day, kind, key, count) values (?, ?, 'page', '/about', 7)`,
        [siteId, day],
      );
      const report = await connectorReport(db.runner, siteId, T, 30);
      expect(report).toMatchObject({ days: 30, views: 12, visitors: 5 });
      expect(report.topPages).toEqual([{ key: "/about", count: 7 }]);
      expect(report.perDay).toHaveLength(30);
      expect(typeof report.publishedPages).toBe("number");
    });
  });
}
