// What the accessibility checker finds across the site, for the accessibility statement draft (spec 18, section 4). Only
// published pages and posts count; each kind is counted and a few pages are named. In SQLite and PostgreSQL.
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { statementDate, summariseAccessibility } from "./accessibility-summary";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000160";
const OTHER = "SITE0000000000000000000161";
const USER = "USER0000000000000000000160";

const image = (alt: string, id = "i") => ({
  id,
  type: "image",
  props: { src: "/uploads/a.png", alt },
});
const heading = (level: number, id = "h") => ({
  id,
  type: "heading",
  props: { level },
  content: [],
});

describe("how a day is written", () => {
  test("in words, in UTC", () => {
    expect(statementDate(Date.UTC(2026, 10, 24, 23, 59))).toBe("24 November 2026");
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the accessibility summary`, () => {
    let db: TestDb;
    let n = 0;
    const entry = async (
      title: string,
      blocks: unknown[],
      status = "published",
      type = "page",
      site = SITE,
    ) => {
      n += 1;
      await db.run(
        `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, seo, meta, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, '{}', ?, '{}', '{}', ?, ?)`,
        [
          `ENT${String(n).padStart(23, "0")}`,
          site,
          type,
          status,
          title,
          `p${n}`,
          USER,
          JSON.stringify({ version: 1, blocks }),
          T,
          T,
        ],
      );
    };

    beforeEach(async () => {
      db = await open();
      n = 0;
      for (const id of [SITE, OTHER])
        await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
          id,
          T,
          T,
        ]);
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, 'Anna', 'anna@garden.example', ?, ?)",
        [USER, T, T],
      );
    });

    test("a site with nothing wrong, or nothing at all, has no findings", async () => {
      expect(await summariseAccessibility(db.runner, SITE)).toEqual({
        pagesChecked: 0,
        findings: [],
      });
      await entry("Fine", [image("A garden gate"), heading(2, "h2"), heading(3, "h3")]);
      expect(await summariseAccessibility(db.runner, SITE)).toEqual({
        pagesChecked: 1,
        findings: [],
      });
    });

    test("each kind of problem is counted, with the first pages named once; only published pages and posts of this site count", async () => {
      await entry("About", [image("", "a"), image("  ", "b"), heading(1, "x"), heading(3, "y")]);
      await entry("Blog post", [image("", "c")], "published", "post");
      await entry("Contact", [image("", "d")]);
      await entry("Gallery", [image("", "e")]);
      await entry("Shop", [image("", "f")]);
      await entry("Draft", [image("", "g")], "draft");
      await entry("Private", [image("", "g")], "private");
      await entry("A product", [image("", "g")], "published", "product");
      await entry("Elsewhere", [image("", "g")], "published", "page", OTHER);
      const s = await summariseAccessibility(db.runner, SITE);
      expect(s.pagesChecked).toBe(5);
      expect(s.findings).toEqual([
        {
          label: "Pictures without a description",
          count: 6,
          // Three pages are named, each once, in title order.
          pages: ["About", "Blog post", "Contact"],
        },
        { label: "Skipped heading levels", count: 1, pages: ["About"] },
      ]);
    });
  });
}
