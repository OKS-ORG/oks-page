// White-label admin (spec 11, section 5; AG-54 to AG-56): the free admin name, the Agency-only logo, help link and footer line,
// nine kinds of bad input refused, and that an ended key only stops showing the extras. In SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import type { LicencePayload } from "./licence.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import {
  adminBrand,
  agencyActive,
  effectiveWhiteLabel,
  loadWhiteLabel,
  NO_WHITE_LABEL,
  saveWhiteLabel,
  tidyText,
} from "./white-label.js";

const T = new Date(1_700_000_000_000);
const NOW = new Date("2027-01-15T12:00:00Z");
const key = (over: Partial<LicencePayload> = {}): LicencePayload => ({
  v: 1,
  id: "k-1",
  kind: "normal",
  covers: ["agency"],
  sites: 10,
  updatesUntil: "2027-06-30",
  maxMajor: null,
  issued: "2026-07-01",
  ...over,
});
const caps = (key: string) => DEFAULT_ROLES.find((r) => r.key === key)!.capabilities;

describe("the Agency key", () => {
  test("only a key that names agency, and still lets the paid features run, unlocks it", () => {
    expect(agencyActive([key()], "example.com", NOW)).toBe(true);
    // An ended yearly key keeps what works (spec 11, section 7: it never breaks a site).
    expect(agencyActive([key({ updatesUntil: "2026-12-31" })], "example.com", NOW)).toBe(true);
    // An ended trial does not.
    expect(
      agencyActive([key({ kind: "trial", updatesUntil: "2026-12-31" })], "example.com", NOW),
    ).toBe(false);
    // A key for every plug-in, or for another item, is not an Agency key.
    expect(agencyActive([key({ covers: ["*"] })], "example.com", NOW)).toBe(false);
    expect(agencyActive([key({ covers: ["shop"] })], "example.com", NOW)).toBe(false);
    expect(agencyActive([], "example.com", NOW)).toBe(false);
    // A development key works on this machine's own addresses only.
    expect(agencyActive([key({ kind: "development" })], "example.com", NOW)).toBe(false);
    expect(agencyActive([key({ kind: "development" })], "localhost", NOW)).toBe(true);
  });
});

describe("what is shown", () => {
  test("text is made safe: tags and control characters go", () => {
    expect(tidyText("  <b>Weber</b>\u0000 Studio\n  Admin ")).toBe("Weber Studio Admin");
    expect(tidyText("<script>alert(1)</script>")).toBe("alert(1)");
    expect(tidyText("<img src=x onerror=y")).toBe("");
  });

  test("a stored value that is not sound is left out", () => {
    expect(effectiveWhiteLabel(null)).toEqual(NO_WHITE_LABEL);
    expect(
      effectiveWhiteLabel({
        name: "x".repeat(41),
        logoId: "not-an-id",
        helpUrl: "javascript:alert(1)",
        footer: "y".repeat(121),
      }),
    ).toEqual(NO_WHITE_LABEL);
    expect(
      effectiveWhiteLabel({
        name: "Weber Studio",
        helpUrl: "mailto:help@weber.example",
        footer: "Made by Weber",
      }),
    ).toMatchObject({
      name: "Weber Studio",
      helpUrl: "mailto:help@weber.example",
      footer: "Made by Weber",
    });
  });

  test("the name always shows; the logo, help link and footer only with an Agency key", () => {
    const wl = {
      name: "Weber Studio",
      logoId: "L".repeat(26),
      helpUrl: "https://weber.example/help",
      footer: "Made by Weber",
    };
    expect(adminBrand(wl, true, "/uploads/logo.png")).toEqual({
      name: "Weber Studio",
      logoUrl: "/uploads/logo.png",
      helpHref: "https://weber.example/help",
      footerText: "Made by Weber",
    });
    expect(adminBrand(wl, false, "/uploads/logo.png")).toEqual({
      name: "Weber Studio",
      logoUrl: null,
      helpHref: null,
      footerText: null,
    });
    expect(adminBrand(NO_WHITE_LABEL, true, null)).toEqual({
      name: "",
      logoUrl: null,
      helpHref: null,
      footerText: null,
    });
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: saving the white-label settings`, () => {
    let db: TestDb;
    let siteId = "";
    let userId = "";
    let admin: Actor;
    let editor: Actor;

    const picture = async (mime: string, status = "ready", site = siteId) => {
      const id = newId();
      await db.run(
        `insert into media (id, site_id, storage_key, filename, mime_type, size_bytes, width, height, alt, caption, title, description, content_hash, status, uploaded_by, created_at)
         values (?, ?, ?, 'logo', ?, 100, 200, 100, '', '', '', '', ?, ?, ?, ?)`,
        [id, site, `k/${id}`, mime, `h${id}`, status, userId, T],
      );
      return id;
    };

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, name, email, T, T],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      userId = setup.userId;
      admin = { userId, can: (c) => caps("administrator").includes(c) };
      editor = { userId, can: (c) => caps("editor").includes(c) };
    });
    afterEach(async () => db.close());

    test("the name is free: any site may set it, it is cleaned, and an empty name goes back to the product's own", async () => {
      expect(await loadWhiteLabel(db.runner, siteId)).toEqual(NO_WHITE_LABEL);
      const r = await saveWhiteLabel(
        db.runner,
        admin,
        siteId,
        { name: "  <b>Weber</b> Studio " },
        false,
      );
      expect(r.ok && r.whiteLabel.name).toBe("Weber Studio");
      expect((await loadWhiteLabel(db.runner, siteId)).name).toBe("Weber Studio");
      await saveWhiteLabel(db.runner, admin, siteId, { name: "" }, false);
      expect((await loadWhiteLabel(db.runner, siteId)).name).toBe("");
    });

    test("the logo, the help link and the footer line need an Agency key, and clearing them never does", async () => {
      const logo = await picture("image/png");
      for (const [field, value] of [
        ["logoId", logo],
        ["helpUrl", "https://weber.example/help"],
        ["footer", "Made by Weber"],
      ] as const) {
        const r = await saveWhiteLabel(
          db.runner,
          admin,
          siteId,
          { name: "W", [field]: value },
          false,
        );
        expect(!r.ok && r.field).toBe(field);
        expect(!r.ok && r.message).toContain("Agency licence key");
      }
      expect(await loadWhiteLabel(db.runner, siteId)).toEqual(NO_WHITE_LABEL);
      const ok = await saveWhiteLabel(
        db.runner,
        admin,
        siteId,
        {
          name: "Weber Studio",
          logoId: logo,
          helpUrl: "https://weber.example/help",
          footer: "Made by Weber",
        },
        true,
      );
      expect(ok.ok).toBe(true);
      expect(await loadWhiteLabel(db.runner, siteId)).toEqual({
        name: "Weber Studio",
        logoId: logo,
        helpUrl: "https://weber.example/help",
        footer: "Made by Weber",
      });
      // The key ends: the owner may clear the extras (the name stays) without a key.
      const cleared = await saveWhiteLabel(
        db.runner,
        admin,
        siteId,
        { name: "Weber Studio", logoId: null, helpUrl: "", footer: "" },
        false,
      );
      expect(cleared.ok).toBe(true);
      expect(await loadWhiteLabel(db.runner, siteId)).toEqual({
        ...NO_WHITE_LABEL,
        name: "Weber Studio",
      });
    });

    test.each([
      [
        "a name that is too long",
        { name: "x".repeat(41) },
        "Admin name: use at most 40 characters.",
      ],
      ["a name that is not words", { name: 5 }, "Admin name: write some words."],
      [
        "a footer that is too long",
        { footer: "y".repeat(121) },
        "Footer line: use at most 120 characters.",
      ],
      [
        "a help link with javascript",
        { helpUrl: "javascript:alert(1)" },
        "Help link: use an address that starts with",
      ],
      [
        "a help link that is plain http",
        { helpUrl: "http://weber.example" },
        "Help link: use an address that starts with",
      ],
      [
        "a help link with a quote that breaks out of an attribute",
        { helpUrl: 'https://x.example/"onmouseover="y' },
        "Help link:",
      ],
      ["a mailto with spaces", { helpUrl: "mailto:a b@weber.example" }, "Help link:"],
      [
        "a logo that is a path",
        { logoId: "/uploads/x.png" },
        "Logo: choose a picture from the library.",
      ],
      ["something that is not a setting", { colour: "red" }, "This is not a white-label setting."],
    ])("%s is refused in plain words and nothing is saved", async (_name, input, words) => {
      const r = await saveWhiteLabel(db.runner, admin, siteId, input, true);
      expect(!r.ok && r.code).toBe("invalid");
      expect(!r.ok && r.message).toContain(words);
      expect(await loadWhiteLabel(db.runner, siteId)).toEqual(NO_WHITE_LABEL);
    });

    test("a logo must be a ready PNG, JPEG, WebP or AVIF picture of this site's library, not an SVG, a video or another site's file", async () => {
      const other = newId();
      await db.run(
        "insert into sites (id, name, created_at, updated_at) values (?, 'Other', ?, ?)",
        [other, T, T],
      );
      const cases: [string, string][] = [
        ["svg", await picture("image/svg+xml")],
        ["pdf", await picture("application/pdf")],
        ["still processing", await picture("image/png", "processing")],
        ["another site's", await picture("image/png", "ready", other)],
        ["one that does not exist", newId()],
      ];
      for (const [name, id] of cases) {
        const r = await saveWhiteLabel(db.runner, admin, siteId, { logoId: id }, true);
        expect(r.ok, name).toBe(false);
        expect(!r.ok && r.message).toContain("Logo:");
      }
      for (const mime of ["image/png", "image/jpeg", "image/webp", "image/avif"])
        expect(
          (await saveWhiteLabel(db.runner, admin, siteId, { logoId: await picture(mime) }, true))
            .ok,
          mime,
        ).toBe(true);
    });

    test("only people who manage the settings may save it, and a request that is not an object is refused", async () => {
      const r = await saveWhiteLabel(db.runner, editor, siteId, { name: "x" }, true);
      expect(!r.ok && r.code).toBe("forbidden");
      for (const bad of [null, "x", 5, [1]]) {
        const x = await saveWhiteLabel(db.runner, admin, siteId, bad, true);
        expect(!x.ok && x.code).toBe("invalid");
      }
    });
  });
}
