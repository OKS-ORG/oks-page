// The words of the consent notice (spec 18, section 2): defaults, what the owner may change, what is refused, and who may.
// In SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  CONSENT_TEXT_FIELDS,
  DEFAULT_CONSENT_TEXTS,
  effectiveTexts,
  loadConsentTexts,
  saveConsentTexts,
} from "./consent-texts.js";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000156";
const SITE2 = "SITE0000000000000000000157";
const admin: Actor = { userId: "USER0000000000000000000156", can: (c) => c === "settings.manage" };
const nobody: Actor = { userId: "USER0000000000000000000156", can: () => false };

describe("the words in force", () => {
  test("the defaults are the standard words, and a bad stored value is ignored", () => {
    expect(effectiveTexts(null)).toEqual(DEFAULT_CONSENT_TEXTS);
    expect(DEFAULT_CONSENT_TEXTS.accept).toBe("Accept all");
    expect(DEFAULT_CONSENT_TEXTS.refuse).toBe("Refuse all");
    expect(
      effectiveTexts({
        title: "  Cookies?  ",
        accept: "x".repeat(31),
        refuse: 5,
        save: "",
        intro: "Line\none",
        nothing: "x",
      }),
    ).toEqual({
      ...DEFAULT_CONSENT_TEXTS,
      title: "Cookies?",
      intro: "Line one",
    });
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the words of the consent notice`, () => {
    let db: TestDb;

    beforeEach(async () => {
      db = await open();
      for (const id of [SITE, SITE2])
        await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
          id,
          T,
          T,
        ]);
    });

    test("an owner may change the words, each site has its own, and an empty field goes back to the standard words", async () => {
      expect(await loadConsentTexts(db.runner, SITE)).toEqual(DEFAULT_CONSENT_TEXTS);
      const saved = await saveConsentTexts(db.runner, admin, SITE, {
        title: "Cookies and you",
        accept: "Yes, please",
        refuse: "No, thanks",
      });
      expect(saved.ok && saved.texts).toEqual({
        ...DEFAULT_CONSENT_TEXTS,
        title: "Cookies and you",
        accept: "Yes, please",
        refuse: "No, thanks",
      });
      expect((await loadConsentTexts(db.runner, SITE)).accept).toBe("Yes, please");
      expect(await loadConsentTexts(db.runner, SITE2)).toEqual(DEFAULT_CONSENT_TEXTS);
      const back = await saveConsentTexts(db.runner, admin, SITE, {
        title: "",
        accept: "Accept all",
      });
      expect(back.ok && back.texts).toEqual(DEFAULT_CONSENT_TEXTS);
    });

    test.each([
      [
        "a heading that is too long",
        { title: "x".repeat(61) },
        "Heading: use at most 60 characters.",
      ],
      [
        "a button that is too long",
        { refuse: "x".repeat(31) },
        "Button: refuse everything: use at most 30 characters.",
      ],
      [
        "something that is not words",
        { accept: 5 },
        "Button: accept everything: write some words.",
      ],
      [
        "a text the notice does not have",
        { colour: "red" },
        "This is not a text of the consent notice.",
      ],
    ])("%s is refused in plain words and nothing is saved", async (_name, input, words) => {
      const r = await saveConsentTexts(db.runner, admin, SITE, input);
      expect(!r.ok && r.code).toBe("invalid");
      expect(!r.ok && r.message).toBe(words);
      expect(await loadConsentTexts(db.runner, SITE)).toEqual(DEFAULT_CONSENT_TEXTS);
    });

    test("only people who manage the settings may change the words, and a request that is not an object is refused", async () => {
      const r = await saveConsentTexts(db.runner, nobody, SITE, { title: "Hi" });
      expect(!r.ok && r.code).toBe("forbidden");
      for (const bad of [null, "x", 5, [1]]) {
        const x = await saveConsentTexts(db.runner, admin, SITE, bad);
        expect(!x.ok && x.code).toBe("invalid");
      }
      expect(CONSENT_TEXT_FIELDS.map((f) => f.id)).toEqual([
        "title",
        "intro",
        "accept",
        "refuse",
        "save",
        "reopen",
      ]);
    });
  });
}
