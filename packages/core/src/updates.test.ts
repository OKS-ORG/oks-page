// Update checks, part 1 (spec 14, UP-01 to UP-05): what the site sends, what it believes, what it keeps and how it compares.
import { generateKeyPairSync, sign } from "node:crypto";
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import {
  compareUpdates,
  compareVersions,
  heldList,
  loadUpdateState,
  loadUpdateView,
  runUpdateCheck,
  saveUpdateChecksOn,
  updateCheckDue,
  updateChecksOn,
  versionMatches,
  type InstalledItem,
} from "./updates.js";
import { UPDATE_LIST_PREFIX, readUpdateList } from "./update-list.js";

const AGENT = "the-product";
const at = (iso: string) => Date.parse(iso);
const actorFor = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (c) => caps.includes(c) };
};

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    sign: (list: unknown) => {
      const body = `${UPDATE_LIST_PREFIX}.${Buffer.from(JSON.stringify(list)).toString("base64url")}`;
      return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
    },
  };
};
const ours = pair();
const stranger = pair();

const sample = (over: Record<string, unknown> = {}) => ({
  v: 1,
  seq: 5,
  issued: "2026-11-25T10:00:00.000Z",
  core: { "1": "1.4.3", "2": "2.0.1" },
  items: [
    { key: "gallery", kind: "plugin", latest: "2.1.0", unsafe: ["2.0.0"] },
    { key: "dusk", kind: "theme", latest: "1.0.2" },
  ],
  warnings: [
    {
      id: "OKS-2026-001",
      affects: "gallery",
      versions: "<2.1.0",
      fixed: "2.1.0",
      severity: "high",
      summary: "A picture caption could run a script.",
      link: "https://example.com/advisories/OKS-2026-001",
    },
    {
      id: "OKS-2026-002",
      affects: "core",
      versions: "<1.4.3",
      fixed: "1.4.3",
      severity: "critical",
      summary: "A page could be read by someone who may not.",
      link: "https://example.com/advisories/OKS-2026-002",
    },
  ],
  ...over,
});
const listOf = (over: Record<string, unknown> = {}) => {
  const read = readUpdateList(ours.sign(sample(over)), [ours.publicKey]);
  if (!read.ok) throw new Error(read.reason);
  return read.list;
};

describe("versions", () => {
  test("compare by number, not by letters; a beta is older than its release", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0-beta.1", "0.1.0")).toBeLessThan(0);
    expect(compareVersions("0.1.0-beta.2", "0.1.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("0.1.0-beta.1", "0.1.0-beta.1")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  test("a warning names versions as one, a limit, or limits joined by commas; what is not understood matches nothing", () => {
    expect(versionMatches("1.2.0", "1.2.0")).toBe(true);
    expect(versionMatches("1.2.1", "1.2.0")).toBe(false);
    expect(versionMatches("1.4.2", "<1.4.3")).toBe(true);
    expect(versionMatches("1.4.3", "<1.4.3")).toBe(false);
    expect(versionMatches("1.4.3", "<=1.4.3")).toBe(true);
    expect(versionMatches("1.4.3", ">1.4.3")).toBe(false);
    expect(versionMatches("1.2.5", "<1.4.3,>=1.2.0")).toBe(true);
    expect(versionMatches("1.1.9", "<1.4.3,>=1.2.0")).toBe(false);
    expect(versionMatches("1.2.0", "all of them")).toBe(false);
    expect(versionMatches("1.2.0", "")).toBe(false);
    expect(versionMatches("not-a-version", "<2.0.0")).toBe(false);
  });
});

describe("the comparison (UP-05)", () => {
  const installed = (core: string, items: InstalledItem[] = []) => ({ core, items });
  const gallery = (version: string): InstalledItem => ({
    key: "gallery",
    kind: "plugin",
    name: "Gallery",
    version,
  });

  test("the core is compared with the newest version of its own major version", () => {
    const behind = compareUpdates(listOf(), installed("1.4.0")).core;
    expect(behind).toEqual({ current: "1.4.0", latest: "1.4.3", behind: true, supported: true });
    expect(compareUpdates(listOf(), installed("1.4.3")).core.behind).toBe(false);
    expect(compareUpdates(listOf(), installed("2.0.0")).core.latest).toBe("2.0.1");
  });

  test("a major version the list does not name no longer gets fixes; an empty list says nothing", () => {
    expect(compareUpdates(listOf(), installed("0.1.0-beta.1")).core.supported).toBe(false);
    expect(compareUpdates(listOf({ core: {} }), installed("0.1.0-beta.1")).core.supported).toBe(
      true,
    );
  });

  test("a plugin is behind, current, unsafe or not tracked", () => {
    const other: InstalledItem = {
      key: "homebrew",
      kind: "plugin",
      name: "Mine",
      version: "1.0.0",
    };
    const result = compareUpdates(listOf(), installed("1.4.3", [gallery("2.0.0"), other]));
    expect(result.items[0]).toMatchObject({
      tracked: true,
      latest: "2.1.0",
      behind: true,
      unsafe: true,
    });
    expect(result.items[1]).toMatchObject({ tracked: false, latest: null, behind: false });
    expect(compareUpdates(listOf(), installed("1.4.3", [gallery("2.1.0")])).items[0]).toMatchObject(
      {
        behind: false,
        unsafe: false,
      },
    );
  });

  test("only the warnings that name something the site runs are kept, the worst first", () => {
    const both = compareUpdates(listOf(), installed("1.4.0", [gallery("2.0.0")]));
    expect(both.warnings.map((w) => w.id)).toEqual(["OKS-2026-002", "OKS-2026-001"]);
    const fixed = compareUpdates(listOf(), installed("1.4.3", [gallery("2.1.0")]));
    expect(fixed.warnings).toEqual([]);
    // A plugin the site does not have is not a warning for it.
    expect(compareUpdates(listOf(), installed("1.4.3")).warnings).toEqual([]);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: update checks`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let eve: Actor;
    let clock = at("2026-11-26T09:00:00Z");
    const URL = "https://updates.example.com/list";
    const keys = [ours.publicKey];
    const answer = (token: string, status = 200): typeof fetch =>
      (async () => new Response(token, { status })) as typeof fetch;
    const check = (f: typeof fetch, url: string | undefined = URL) =>
      runUpdateCheck(db.runner, siteId, {
        url,
        keys,
        fetch: f,
        now: () => clock,
        userAgent: AGENT,
      });

    beforeEach(async () => {
      db = await open();
      clock = at("2026-11-26T09:00:00Z");
      const setup = await runSetup(
        db.runner,
        async (input) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, input.name, input.email, new Date(clock), new Date(clock)],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@garden.test", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      anna = actorFor(setup.userId, "administrator");
      eve = actorFor(setup.userId, "editor");
    });
    afterEach(async () => {
      await db.close();
    });

    test("UP-01 the request carries nothing about the site: no cookie, no query, no version, the agent is only the product name", async () => {
      const seen: { url: string; init: RequestInit }[] = [];
      const spy = (async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), init });
        return new Response(ours.sign(sample()));
      }) as unknown as typeof fetch;
      await check(spy);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(URL);
      expect(new globalThis.URL(seen[0]!.url).search).toBe("");
      expect(seen[0]!.init.method).toBe("GET");
      expect(seen[0]!.init.credentials).toBe("omit");
      expect(seen[0]!.init.referrerPolicy).toBe("no-referrer");
      expect(seen[0]!.init.body).toBeUndefined();
      const headers = seen[0]!.init.headers as Record<string, string>;
      expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
      expect(headers["user-agent"]).toBe(AGENT);
    });

    test("a list we signed is kept; the same list again is told as the same", async () => {
      expect(await check(answer(ours.sign(sample())))).toEqual({ status: "new", seq: 5 });
      expect(await check(answer(ours.sign(sample())))).toEqual({ status: "same", seq: 5 });
      const state = await loadUpdateState(db.runner, siteId);
      expect(state.checkedAt).toBe(clock);
      expect(state.failure).toBe("");
      expect(heldList(state, keys)?.seq).toBe(5);
    });

    test("UP-02 a list signed by someone else, or changed, is refused and the site keeps the one it had", async () => {
      await check(answer(ours.sign(sample())));
      const forged = await check(answer(stranger.sign(sample({ seq: 9 }))));
      expect(forged).toMatchObject({ status: "refused" });
      const edited = ours.sign(sample({ seq: 9 })).replace(/\.[^.]+$/, ".AAAA");
      expect(await check(answer(edited))).toMatchObject({ status: "refused" });
      const state = await loadUpdateState(db.runner, siteId);
      expect(heldList(state, keys)?.seq).toBe(5);
      expect(state.failure).not.toBe("");
    });

    test("UP-03 an older list is refused: an old list cannot hide a warning again", async () => {
      await check(answer(ours.sign(sample({ seq: 7 }))));
      const result = await check(answer(ours.sign(sample({ seq: 6, warnings: [] }))));
      expect(result).toMatchObject({ status: "refused" });
      expect(heldList(await loadUpdateState(db.runner, siteId), keys)?.seq).toBe(7);
      expect(await check(answer(ours.sign(sample({ seq: 8 }))))).toEqual({ status: "new", seq: 8 });
    });

    test("a server that does not answer, answers badly or is not https changes nothing but the note", async () => {
      await check(answer(ours.sign(sample())));
      const down = (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      expect(await check(down)).toMatchObject({ status: "failed" });
      expect(await check(answer("nope", 503))).toMatchObject({ status: "failed" });
      expect(
        await check(answer(ours.sign(sample())), "http://updates.example.com/list"),
      ).toMatchObject({
        status: "failed",
      });
      expect(await check(answer("x".repeat(3 * 1024 * 1024)))).toMatchObject({ status: "refused" });
      const state = await loadUpdateState(db.runner, siteId);
      expect(heldList(state, keys)?.seq).toBe(5);
      expect(state.failure).not.toBe("");
      // A later good look clears the note.
      await check(answer(ours.sign(sample())));
      expect((await loadUpdateState(db.runner, siteId)).failure).toBe("");
    });

    test("with no address nothing is fetched; with checks off nothing is fetched either", async () => {
      let calls = 0;
      const counting = (async () => {
        calls++;
        return new Response(ours.sign(sample()));
      }) as unknown as typeof fetch;
      expect(
        await runUpdateCheck(db.runner, siteId, {
          url: undefined,
          keys,
          fetch: counting,
          userAgent: AGENT,
        }),
      ).toEqual({ status: "no_server" });
      expect(await check(counting, "  ")).toEqual({ status: "no_server" });
      await saveUpdateChecksOn(db.runner, anna, siteId, false);
      expect(await check(counting)).toEqual({ status: "off" });
      expect(calls).toBe(0);
    });

    test("only people who manage the settings switch the checks, and only with a yes or a no", async () => {
      expect(await updateChecksOn(db.runner, siteId)).toBe(true);
      expect(await saveUpdateChecksOn(db.runner, eve, siteId, false)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await saveUpdateChecksOn(db.runner, anna, siteId, "no")).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await saveUpdateChecksOn(db.runner, anna, siteId, false)).toEqual({
        ok: true,
        on: false,
      });
      expect(await updateChecksOn(db.runner, siteId)).toBe(false);
      expect(await saveUpdateChecksOn(db.runner, anna, siteId, true)).toEqual({
        ok: true,
        on: true,
      });
    });

    test("a look is due once a day", async () => {
      expect(updateCheckDue(await loadUpdateState(db.runner, siteId), clock)).toBe(true);
      await check(answer(ours.sign(sample())));
      const state = await loadUpdateState(db.runner, siteId);
      expect(updateCheckDue(state, clock + 3 * 60 * 60 * 1000)).toBe(false);
      expect(updateCheckDue(state, clock + 25 * 60 * 60 * 1000)).toBe(true);
      // A failed look is not tried again at once either.
      await check(answer("nope", 500));
      expect(updateCheckDue(await loadUpdateState(db.runner, siteId), clock + 60 * 60 * 1000)).toBe(
        false,
      );
    });

    test("UP-04 the screen tells off, no server, failing, too old (more than 7 days) and fine", async () => {
      const installed = { core: "1.4.0", items: [] };
      const view = () =>
        loadUpdateView(db.runner, siteId, installed, { keys, now: () => clock, url: URL });
      expect((await view()).health).toBe("no_server");
      await check(answer("nope", 500));
      expect((await view()).health).toBe("failing");
      await check(answer(ours.sign(sample({ issued: "2026-11-25T10:00:00.000Z" }))));
      const fine = await view();
      expect(fine.health).toBe("ok");
      expect(fine.seq).toBe(5);
      expect(fine.comparison?.core.behind).toBe(true);
      expect(fine.comparison?.warnings.map((w) => w.id)).toEqual(["OKS-2026-002"]);
      clock = at("2026-12-03T10:30:00Z");
      expect((await view()).health).toBe("stale");
      clock = at("2026-12-02T09:00:00Z");
      expect((await view()).health).toBe("ok");
      await saveUpdateChecksOn(db.runner, anna, siteId, false);
      expect((await view()).health).toBe("off");
    });

    test("a list kept earlier is not believed when the keys built in no longer include its key", async () => {
      await check(answer(ours.sign(sample())));
      const view = await loadUpdateView(
        db.runner,
        siteId,
        { core: "1.4.0", items: [] },
        { keys: [stranger.publicKey], now: () => clock },
      );
      expect(view.seq).toBeNull();
      expect(view.comparison).toBeNull();
    });
  });
}
