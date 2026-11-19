import { generateKeyPairSync } from "node:crypto";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  addLicence,
  bestLicenceState,
  licenceState,
  listLicences,
  readLicence,
  removeLicence,
  signLicence,
  type LicencePayload,
} from "./licence.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    priv: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
};
const ours = pair();
const other = pair();

const base: LicencePayload = {
  v: 1,
  id: "k-1",
  kind: "normal",
  covers: ["shop"],
  sites: 3,
  updatesUntil: "2027-06-30",
  maxMajor: null,
  issued: "2026-07-01",
};
const make = (patch: Partial<LicencePayload> = {}, priv = ours.priv) =>
  signLicence({ ...base, ...patch }, priv);
const ctx = (over: Partial<{ item: string; host: string; now: Date; version: string }> = {}) => ({
  item: "shop",
  host: "example.com",
  now: new Date("2027-01-15T12:00:00Z"),
  ...over,
});

describe("licence keys: the signed token (ADR 0037)", () => {
  test("a key made with our signing key is read back; a key made with another key, or changed, is refused", () => {
    const token = make();
    expect(readLicence(token, [ours.pub])).toMatchObject({
      ok: true,
      licence: { id: "k-1", sites: 3 },
    });
    expect(readLicence(make({}, other.priv), [ours.pub])).toMatchObject({ ok: false });
    // The next key (ADR 0039): either of the two built-in keys verifies.
    expect(readLicence(make({}, other.priv), [ours.pub, other.pub])).toMatchObject({ ok: true });
    // One changed letter in the payload breaks the signature.
    const [prefix, payload, signature] = token.split(".");
    const changed = Buffer.from(payload!, "base64url").toString().replace('"sites":3', '"sites":9');
    const forged = `${prefix}.${Buffer.from(changed).toString("base64url")}.${signature}`;
    expect(readLicence(forged, [ours.pub])).toMatchObject({ ok: false });
    // With no built-in key nothing verifies.
    expect(readLicence(token, [])).toMatchObject({ ok: false });
  });

  test("text that is not a key, and keys that are signed but incomplete, are refused in plain words", () => {
    for (const bad of [42, "", "hello", "OKS1.a.b", "OKS2.a.b.c", null]) {
      const read = readLicence(bad, [ours.pub]);
      expect(read.ok, String(bad)).toBe(false);
    }
    for (const patch of [
      { sites: 0 },
      { sites: 1.5 },
      { covers: [] },
      { kind: "gold" as never },
      { updatesUntil: "next year" },
      { maxMajor: 0 },
      { id: "" },
    ]) {
      expect(readLicence(make(patch), [ours.pub]), JSON.stringify(patch)).toMatchObject({
        ok: false,
        reason: "The key is not complete.",
      });
    }
  });

  test("a field an older site does not know is ignored, so new key types can be added later", () => {
    const token = signLicence(
      { ...base, futureField: "x" } as unknown as LicencePayload,
      ours.priv,
    );
    const read = readLicence(token, [ours.pub]);
    expect(read).toMatchObject({ ok: true });
    expect(read.ok && "futureField" in read.licence).toBe(false);
  });
});

describe("licence keys: what a key lets a site do", () => {
  test("a yearly key gives updates until its last day, then the item keeps working without updates", () => {
    expect(licenceState(base, ctx({ now: new Date("2027-06-30T23:00:00Z") }))).toMatchObject({
      status: "active",
      updates: true,
      paidFeatures: true,
    });
    const ended = licenceState(base, ctx({ now: new Date("2027-07-01T00:00:01Z") }));
    expect(ended).toMatchObject({ status: "updates-ended", updates: false, paidFeatures: true });
    expect(ended.message).toContain("keeps working");
  });

  test("a lifetime key covers its major version; a later major version needs an upgrade key, and it still works", () => {
    const lifetime = { ...base, updatesUntil: null, maxMajor: 1 };
    expect(
      licenceState(lifetime, ctx({ version: "1.9.2", now: new Date("2040-01-01") })),
    ).toMatchObject({
      status: "active",
      updates: true,
    });
    expect(licenceState(lifetime, ctx({ version: "2.0.0" }))).toMatchObject({
      status: "updates-ended",
      updates: false,
      paidFeatures: true,
    });
    // An upgrade key for version 2 is just another lifetime key with maxMajor 2.
    const upgrade = { ...lifetime, id: "k-2", maxMajor: 2 };
    expect(bestLicenceState([lifetime, upgrade], ctx({ version: "2.0.0" }))).toMatchObject({
      status: "active",
      updates: true,
    });
  });

  test("a key covers the items it lists, or all of them with *", () => {
    expect(licenceState(base, ctx({ item: "forms" }))).toMatchObject({
      status: "not-for-this-item",
    });
    expect(licenceState({ ...base, covers: ["*"] }, ctx({ item: "forms" }))).toMatchObject({
      status: "active",
    });
    // A bundle: a plug-in and a theme on one key.
    expect(
      licenceState({ ...base, covers: ["shop", "dusk"] }, ctx({ item: "dusk" })),
    ).toMatchObject({
      status: "active",
    });
  });

  test("a trial stops its paid features when it ends; a development key works only on local addresses", () => {
    const trial = { ...base, kind: "trial" as const, sites: 1, updatesUntil: "2027-01-31" };
    expect(licenceState(trial, ctx())).toMatchObject({ status: "active", paidFeatures: true });
    expect(licenceState(trial, ctx({ now: new Date("2027-02-02") }))).toMatchObject({
      status: "trial-ended",
      paidFeatures: false,
      updates: false,
    });
    const dev = { ...base, kind: "development" as const, updatesUntil: null };
    for (const host of ["localhost", "shop.test", "a.localhost", "127.0.0.1"])
      expect(licenceState(dev, ctx({ host })), host).toMatchObject({ status: "active" });
    expect(licenceState(dev, ctx({ host: "example.com" }))).toMatchObject({
      status: "wrong-address",
      paidFeatures: false,
    });
  });

  test("with several keys, the one that still gives updates wins; no key means no state", () => {
    const old = { ...base, id: "old", updatesUntil: "2026-01-01" };
    const fresh = { ...base, id: "fresh", updatesUntil: "2028-01-01" };
    expect(bestLicenceState([old, fresh], ctx())).toMatchObject({ updates: true });
    expect(bestLicenceState([old], ctx())).toMatchObject({ status: "updates-ended" });
    expect(bestLicenceState([], ctx())).toBeNull();
  });
});

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the keys of a site`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let eve: Actor;

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const userId = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [userId, name, email, T, T],
          );
          return { userId };
        },
        {
          siteName: "S",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      anna = actorOf(setup.userId, "administrator");
      eve = actorOf(newId(), "editor");
    });
    afterEach(async () => {
      await db.close();
    });

    test("an administrator adds a key, it is listed, a second add of it is refused, and it can be removed", async () => {
      expect(await listLicences(db.runner, siteId, [ours.pub])).toEqual([]);
      const added = await addLicence(db.runner, anna, siteId, make(), [ours.pub]);
      expect(added).toMatchObject({ ok: true, licence: { id: "k-1" } });
      expect(await listLicences(db.runner, siteId, [ours.pub])).toHaveLength(1);
      expect(await addLicence(db.runner, anna, siteId, make(), [ours.pub])).toMatchObject({
        ok: false,
        code: "invalid",
        message: "This key is already added.",
      });
      expect(
        await addLicence(db.runner, anna, siteId, make({ id: "k-2" }), [ours.pub]),
      ).toMatchObject({
        ok: true,
      });
      expect(await removeLicence(db.runner, anna, siteId, "k-1", [ours.pub])).toEqual({ ok: true });
      expect((await listLicences(db.runner, siteId, [ours.pub])).map((l) => l.id)).toEqual(["k-2"]);
      expect(await removeLicence(db.runner, anna, siteId, "k-1", [ours.pub])).toMatchObject({
        ok: false,
        code: "not-found",
      });
      const rows = await db.run("select revision from settings where key = 'licences'");
      expect(rows).toHaveLength(1);
    });

    test("a key that does not verify is refused and not stored; an editor may not add or remove keys", async () => {
      expect(
        await addLicence(db.runner, anna, siteId, make({}, other.priv), [ours.pub]),
      ).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await addLicence(db.runner, anna, siteId, "garbage", [ours.pub])).toMatchObject({
        ok: false,
      });
      expect(await addLicence(db.runner, eve, siteId, make(), [ours.pub])).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      await addLicence(db.runner, anna, siteId, make(), [ours.pub]);
      expect(await removeLicence(db.runner, eve, siteId, "k-1", [ours.pub])).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await db.run("select 1 from settings where key = 'licences'")).toHaveLength(1);
    });

    test("when the signing key is replaced, keys made with the old key stop being listed but are not deleted", async () => {
      await addLicence(db.runner, anna, siteId, make(), [ours.pub]);
      expect(await listLicences(db.runner, siteId, [other.pub])).toEqual([]);
      expect(await listLicences(db.runner, siteId, [other.pub, ours.pub])).toHaveLength(1);
    });
  });
}
