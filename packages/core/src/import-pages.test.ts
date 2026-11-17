import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { importPagesFromCsv, MAX_IMPORT_CHARS, MAX_IMPORT_ROWS, parseCsv } from "./import-pages.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("reading CSV", () => {
  test("quotes, doubled quotes, new lines inside quotes, a byte-order mark and blank lines", () => {
    expect(
      parseCsv('﻿title,content\r\n"Hello, world","Say ""hi""\nthen go"\r\n\r\nPlain,text'),
    ).toEqual([
      ["title", "content"],
      ["Hello, world", 'Say "hi"\nthen go'],
      ["Plain", "text"],
    ]);
    // A file made by a spreadsheet in a language that writes the separator as a semicolon.
    expect(parseCsv("title;content\nOne;Two")).toEqual([
      ["title", "content"],
      ["One", "Two"],
    ]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv('a,"unfinished')).toEqual([["a", "unfinished"]]);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: importing pages from a CSV file`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let contributor: Actor;

    beforeEach(async () => {
      db = await open();
      const result = await runSetup(
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
          tagline: "Plants and pots",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = result.siteId;
      admin = actorOf(result.userId, "administrator");
      contributor = actorOf(result.userId, "contributor");
    });
    afterEach(async () => {
      await db.close();
    });

    const entry = async (id: string) =>
      (
        await db.runner.all(
          `select "title", "slug", "status", "plain_text", "type_key" from "entries" where "id" = ?`,
          [id],
        )
      )[0]!;

    test("rows become pages: published only when they pass the publish check, otherwise drafts with the reason", async () => {
      const csv = [
        "title,slug,type,status,content",
        'About us,about,page,published,"We grow plants.\n\nCome and see."',
        "Empty one,empty,page,published,",
        ",nothing,page,draft,Words",
        "Recipe,r,recipe,draft,Words",
        "Odd status,odd,page,live,Words",
        "Second about,about,page,published,Another",
        "Bad address,Bad Address!,page,draft,Words",
        "Just a draft,,page,,Some words",
        "A post,a-post,post,published,Fresh news",
      ].join("\n");
      const result = await importPagesFromCsv(db.runner, admin, siteId, csv);
      if (!result.ok) throw new Error(result.message);
      const byRow = (n: number) => result.items.find((i) => i.row === n)!;

      // Row 2: published, with its two paragraphs and the address it asked for.
      expect(byRow(2)).toMatchObject({ outcome: "created", status: "published", slug: "about" });
      expect(byRow(2).note).toBeUndefined();
      expect(await entry(byRow(2).id!)).toMatchObject({
        status: "published",
        plain_text: "We grow plants.\nCome and see.",
        title: "About us",
      });
      // Row 3: asked to be published, has no content: kept as a draft, with the reason.
      expect(byRow(3)).toMatchObject({ outcome: "created", status: "draft" });
      expect(byRow(3).note).toMatch(/Kept as a draft\. It has no content yet/);
      expect((await entry(byRow(3).id!))["status"]).toBe("draft");
      // Row 4: no title, skipped. Row 5: a kind that does not exist, skipped.
      expect(byRow(4)).toMatchObject({ outcome: "skipped", note: "It has no title." });
      expect(byRow(5)).toMatchObject({ outcome: "skipped" });
      expect(byRow(5).note).toMatch(/does not exist/);
      // Row 6: a status that is not one: a draft, and it says so. Row 7: the address is taken: one is made.
      expect(byRow(6)).toMatchObject({ status: "draft" });
      expect(byRow(6).note).toMatch(/"live" is not a status/);
      expect(byRow(7)).toMatchObject({ status: "published" });
      expect(byRow(7).note).toMatch(/already used/);
      expect(byRow(7).slug).not.toBe("about");
      // Row 8: an address that cannot be used: one is made from the title.
      expect(byRow(8).note).toMatch(/address was not usable/);
      // Row 9: no status means a draft, with nothing to say. Row 10: a post goes under the posts' address.
      expect(byRow(9)).toMatchObject({ status: "draft" });
      expect(byRow(9).note).toBeUndefined();
      expect(byRow(10)).toMatchObject({ status: "published" });
      expect((await entry(byRow(10).id!))["type_key"]).toBe("post");

      expect(result).toMatchObject({ created: 7, published: 3, keptAsDrafts: 1, skipped: 2 });
      // Nothing that was refused is left in the site as a half-made page.
      expect(
        Number(
          (await db.run("select count(*) as c from entries where status = 'published'"))[0]!["c"],
        ),
      ).toBe(3);
      const log = await db.run(
        `select "action", "detail" from "audit_log" where "action" = 'content.import'`,
      );
      expect(log).toHaveLength(1);
    });

    test("a person who may not publish gets drafts, with the reason", async () => {
      const result = await importPagesFromCsv(
        db.runner,
        contributor,
        siteId,
        "title,status,content\nMy page,published,Words here",
      );
      if (!result.ok) throw new Error(result.message);
      expect(result.items[0]).toMatchObject({ outcome: "created", status: "draft" });
      expect(result.items[0]!.note).toMatch(/may not publish/);
      expect(result.published).toBe(0);
    });

    test("a person who may not add this kind of content has the rows skipped", async () => {
      const nobody: Actor = { userId: admin.userId, can: () => false };
      const result = await importPagesFromCsv(db.runner, nobody, siteId, "title\nNo rights");
      if (!result.ok) throw new Error(result.message);
      expect(result).toMatchObject({ created: 0, skipped: 1 });
      expect(result.items[0]!.note).toMatch(/may not add/);
    });

    test("a file with no title column, no rows, too many rows or too much text is refused with a plain reason", async () => {
      for (const [csv, message] of [
        ["name2,content\nx,y", /must name the columns/],
        ["title", /no rows/],
        [`title\n${"a\n".repeat(MAX_IMPORT_ROWS + 1)}`, /At most 500/],
        [`title\n${"a".repeat(MAX_IMPORT_CHARS + 1)}`, /too big/],
      ] as const) {
        const result = await importPagesFromCsv(db.runner, admin, siteId, csv);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toMatch(message);
      }
      expect(Number((await db.run("select count(*) as c from entries"))[0]!["c"])).toBe(0);
    });
  });
}
