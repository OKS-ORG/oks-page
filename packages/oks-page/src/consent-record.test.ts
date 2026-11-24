// The consent notice's side of the site (spec 18, section 2; PR-02, PR-03): which purposes it asks about, the record of a
// choice (nothing that points to a person) and what a browser remembers. In SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { readChoice, REMEMBER_MS, STORE_KEY, writeChoice } from "./consent-choice";
import type { ConsentNeeds } from "./consent-needs";
import { consentInfoOf, purposesOf, recordConsent } from "./consent-record";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000155";

const needs = (over: Partial<ConsentNeeds> = {}): ConsentNeeds => ({
  plugins: [],
  videos: [],
  needed: false,
  ...over,
});
const plugin = (purpose: string, kind: "cookies" | "hosts" = "cookies") => ({
  plugin: "p",
  cookies: kind === "cookies" ? [{ name: "c", purpose: purpose as never, why: "w" }] : [],
  outsideHosts:
    kind === "hosts" ? [{ host: "a.example.com", purpose: purpose as never, why: "w" }] : [],
});

describe("what the notice asks about", () => {
  test("nothing on a new site; essential things are never asked", () => {
    expect(consentInfoOf(needs())).toEqual({ needed: false, purposes: [], version: "" });
    expect(
      consentInfoOf(needs({ plugins: [plugin("essential"), plugin("essential", "hosts")] })).needed,
    ).toBe(false);
  });

  test("each purpose a plugin declares, and media for a video that loads at once, in a fixed order, once each", () => {
    const all = needs({
      plugins: [plugin("marketing"), plugin("statistics", "hosts"), plugin("marketing", "hosts")],
      videos: [{ entryId: "E", title: "t", company: "youtube.com" }],
    });
    expect(purposesOf(all)).toEqual(["statistics", "media", "marketing"]);
    expect(consentInfoOf(all)).toEqual({
      needed: true,
      purposes: ["statistics", "media", "marketing"],
      version: "statistics,media,marketing",
    });
    expect(consentInfoOf(needs({ plugins: [plugin("media", "hosts")] })).version).toBe("media");
  });
});

describe("what a browser remembers", () => {
  const NOW = 1_800_000_000_000;
  test("a choice for this version, younger than six months, is used", () => {
    const raw = writeChoice(["media"], "media", NOW - 1000);
    expect(readChoice(raw, "media", NOW)).toEqual({
      accepted: ["media"],
      version: "media",
      at: NOW - 1000,
    });
    expect(STORE_KEY).toBe("oks-consent");
  });

  test.each([
    ["nothing", null],
    ["text that is not a choice", "hello"],
    ["a list that is not a list", JSON.stringify({ accepted: "media", version: "media", at: 1 })],
    ["a choice from another version", writeChoice(["media"], "media,statistics", NOW - 1000)],
    ["a choice older than six months", writeChoice(["media"], "media", NOW - REMEMBER_MS)],
    ["a choice from the future", writeChoice(["media"], "media", NOW + 1000)],
  ])("%s is not used", (_name, raw) => {
    expect(readChoice(raw, "media", NOW)).toBeNull();
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the record of a choice`, () => {
    let db: TestDb;
    const rows = () =>
      db.runner.all(
        `select "choice", "version", "created_at" from "consent_records" order by "created_at"`,
      );

    beforeEach(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
    });

    test("a choice is kept with its time and version, and nothing else", async () => {
      expect(
        await recordConsent(
          db.runner,
          SITE,
          { accepted: ["media", "statistics"], version: "statistics,media" },
          () => 1_800_000_000_000,
        ),
      ).toEqual({ ok: true });
      expect(
        await recordConsent(
          db.runner,
          SITE,
          { accepted: [], version: "statistics,media" },
          () => 1_800_000_001_000,
        ),
      ).toEqual({ ok: true });
      const kept = await rows();
      expect(kept.map((r) => [r["choice"], r["version"]])).toEqual([
        ["statistics,media", "statistics,media"],
        ["", "statistics,media"],
      ]);
      const columns = await db.runner.all(
        kind === "sqlite"
          ? `select name from pragma_table_info('consent_records') order by cid`
          : `select column_name as name from information_schema.columns where table_name = 'consent_records' and table_schema = current_schema() order by ordinal_position`,
      );
      expect(columns.map((c) => c["name"])).toEqual([
        "id",
        "site_id",
        "choice",
        "version",
        "created_at",
      ]);
    });

    test.each([
      ["a purpose the notice does not have", { accepted: ["tracking"], version: "media" }],
      ["essential, which is never asked", { accepted: ["essential"], version: "media" }],
      ["the same purpose twice", { accepted: ["media", "media"], version: "media" }],
      [
        "a list that is too long",
        { accepted: ["statistics", "media", "marketing", "media"], version: "media" },
      ],
      ["no list", { version: "media" }],
      ["a version that is not words", { accepted: [], version: "<script>" }],
      ["no version", { accepted: [] }],
      ["a version that is too long", { accepted: [], version: "a".repeat(41) }],
    ])("%s is refused and nothing is kept", async (_name, input) => {
      const r = await recordConsent(db.runner, SITE, input);
      expect(r.ok).toBe(false);
      expect((await rows()).length).toBe(0);
    });
  });
}
