// The imprint and the accessibility statement drafts (spec 18, section 4): what is asked for, what is refused, what the drafts
// say (and do not say), and that a draft is a page that is not published. In SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  accessibilityStatementBlocks,
  imprintDraftBlocks,
  readImprint,
  writeAccessibilityStatementDraft,
  writeImprintDraft,
} from "./legal-drafts.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};
const words = (blocks: unknown[]) => JSON.stringify(blocks);
const GOOD = {
  name: "Anna Weber, Weber Garden",
  address: "Lindenstrasse 4\n10115 Berlin\nGermany",
  email: "anna@garden.example",
};

describe("the imprint form", () => {
  test("the three things every imprint needs are asked for, the rest is optional", () => {
    expect(readImprint(GOOD)).toMatchObject({ ok: true });
    for (const field of ["name", "address", "email"]) {
      const r = readImprint({ ...GOOD, [field]: "  " });
      expect(!r.ok && r.field).toBe(field);
      expect(!r.ok && r.message).toContain("this is needed");
    }
    const all = readImprint({
      ...GOOD,
      phone: "+49 30 1234567",
      register: "Amtsgericht Berlin HRB 12345",
      vat: "DE123456789",
      responsible: "Anna Weber",
    });
    expect(all.ok && Object.keys(all.value)).toHaveLength(7);
  });

  test.each([
    ["an email that is not one", { ...GOOD, email: "anna" }, "Email address: write an address"],
    [
      "a name that is too long",
      { ...GOOD, name: "x".repeat(121) },
      "Who runs the site: use at most 120 characters.",
    ],
    ["something that is not words", { ...GOOD, phone: 5 }, "Phone number: write some words."],
    [
      "a field an imprint does not have",
      { ...GOOD, colour: "red" },
      "This is not part of an imprint.",
    ],
    ["a request that is not an object", "x", "The request was not understood."],
  ])("%s is refused in plain words", (_name, input, message) => {
    const r = readImprint(input);
    expect(!r.ok && r.message).toContain(message);
  });

  test("the draft has only what was entered, line by line, and says it must be checked", () => {
    const text = words(
      imprintDraftBlocks(
        readImprint(GOOD).ok ? (readImprint(GOOD) as { value: never }).value : ({} as never),
      ),
    );
    expect(text).toContain("Weber Garden");
    expect(text).toContain("Lindenstrasse 4");
    expect(text).toContain("10115 Berlin");
    expect(text).toContain("Email: anna@garden.example");
    expect(text).not.toContain("Phone");
    expect(text).not.toContain("VAT");
    expect(text).toContain("Check it against the law of your country");
  });
});

describe("the accessibility statement text", () => {
  const facts = {
    siteName: "Anna's Garden",
    contactEmail: "anna@garden.example",
    date: "24 November 2026",
    pagesChecked: 12,
    findings: [] as { label: string; count: number; pages: string[] }[],
  };

  test("with nothing found it still does not claim that the site meets the standard", () => {
    const text = words(accessibilityStatementBlocks(facts));
    expect(text).toContain("read 12 published pages and found none of the problems it can detect");
    expect(text).toContain("we do not claim that the site fully meets WCAG 2.1 AA");
    expect(text).not.toContain("Known problems");
    expect(text).toContain("anna@garden.example");
    expect(text).toContain("last updated on 24 November 2026");
  });

  test("with findings it lists each kind, how often and where, and counts correctly in the singular", () => {
    const text = words(
      accessibilityStatementBlocks({
        ...facts,
        pagesChecked: 1,
        findings: [
          { label: "Pictures without a description", count: 3, pages: ["About", "Contact"] },
          { label: "Skipped heading levels", count: 1, pages: [] },
        ],
      }),
    );
    expect(text).toContain("read 1 published page and found 4 problems it can detect");
    expect(text).toContain("Known problems");
    expect(text).toContain(
      "Pictures without a description: 3 times, for example on About, Contact.",
    );
    expect(text).toContain("Skipped heading levels: 1 time.");
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the drafts`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;

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
      admin = actorOf(setup.userId, "administrator");
      editor = actorOf(setup.userId, "editor");
    });
    afterEach(async () => db.close());

    const page = async (id: string) =>
      (
        await db.runner.all(`select "type_key", "status", "title" from "entries" where "id" = ?`, [
          id,
        ])
      )[0];

    test("the imprint draft is a page that is not published; only people who manage the settings; a bad form makes nothing", async () => {
      expect(await writeImprintDraft(db.runner, editor, siteId, GOOD)).toMatchObject({
        code: "forbidden",
      });
      expect(
        await writeImprintDraft(db.runner, admin, siteId, { ...GOOD, email: "x" }),
      ).toMatchObject({
        code: "invalid",
      });
      const none = await db.runner.all(`select "id" from "entries" where "title" = 'Imprint'`);
      expect(none.length).toBe(0);
      const made = await writeImprintDraft(db.runner, admin, siteId, GOOD);
      if (!made.ok) throw new Error(made.message);
      expect(await page(made.id)).toMatchObject({
        type_key: "page",
        status: "draft",
        title: "Imprint",
      });
      // A second one is another draft; the first is not overwritten.
      const again = await writeImprintDraft(db.runner, admin, siteId, GOOD);
      expect(again.ok && again.id).not.toBe(made.id);
    });

    test("the accessibility statement draft is a page that is not published and needs a contact address", async () => {
      const facts = {
        siteName: "Anna's Garden",
        contactEmail: "anna@garden.example",
        date: "24 November 2026",
        pagesChecked: 3,
        findings: [{ label: "Skipped heading levels", count: 2, pages: ["About"] }],
      };
      expect(
        await writeAccessibilityStatementDraft(db.runner, editor, siteId, facts),
      ).toMatchObject({
        code: "forbidden",
      });
      expect(
        await writeAccessibilityStatementDraft(db.runner, admin, siteId, {
          ...facts,
          contactEmail: "nope",
        }),
      ).toMatchObject({ code: "invalid", field: "contactEmail" });
      const made = await writeAccessibilityStatementDraft(db.runner, admin, siteId, facts);
      if (!made.ok) throw new Error(made.message);
      expect(await page(made.id)).toMatchObject({
        type_key: "page",
        status: "draft",
        title: "Accessibility statement",
      });
    });
  });
}
