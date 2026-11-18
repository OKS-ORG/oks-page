import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  MOST_INDEXED,
  buildIndex,
  extractOf,
  loadSearchIndex,
  loadSearchRows,
  loadSearchTexts,
  normalize,
  search,
  searchStamp,
  wordsOf,
  type SearchRow,
} from "./search.js";
import { runSetup } from "./setup.js";

const row = (id: string, title: string, text = "", extra: Partial<SearchRow> = {}): SearchRow => ({
  id,
  title,
  slug: `blog/${id}`,
  type: "post",
  publishedAt: 1000,
  text,
  terms: [],
  ...extra,
});
const ids = (rows: SearchRow[], query: string, exact = false) =>
  search(buildIndex(rows), query, exact).hits.map((h) => h.row.id);

describe("words", () => {
  test("case, accents and Arabic vowel marks are ignored; digits and other scripts count as words", () => {
    expect(normalize("Café CRÈME")).toBe("cafe creme");
    expect(wordsOf("Café, crème-brûlée! 2026 हिन्दी")).toEqual([
      "cafe",
      "creme",
      "brulee",
      "2026",
      "हिन्दी",
    ]);
    expect(wordsOf("مَكْتَبَة")).toEqual(wordsOf("مكتبة"));
    expect(wordsOf("   ...  ")).toEqual([]);
  });
});

describe("matching (SEO-70 to SEO-73)", () => {
  const rows = [
    row("a", "Our bakery", "Fresh bread every morning."),
    row("b", "Opening hours", "Come to the bakery at nine."),
    row("c", "A small café", "Coffee and cake."),
    row("d", "Sourdough basics", "Flour, water, salt."),
  ];

  test("the last word may be unfinished: bake finds bakery; earlier words must be whole", () => {
    expect(ids(rows, "bake")).toEqual(["a", "b"]);
    expect(ids(rows, "baker")).toEqual(["a", "b"]);
    expect(ids(rows, "bakery bread")).toEqual(["a"]);
    expect(ids(rows, "bak bread")).toEqual([]); // "bak" is not the last word, so it must be a whole word
  });

  test("cafe finds café, and the other way round; case does not matter", () => {
    expect(ids(rows, "CAFE")).toEqual(["c"]);
    expect(ids([row("x", "Cafe")], "café")).toEqual(["x"]);
  });

  test("every word must be found, in any field", () => {
    expect(ids(rows, "bakery morning")).toEqual(["a"]);
    expect(ids(rows, "bakery coffee")).toEqual([]);
  });

  test("a title match ranks above a category match above a text match; equal ones: newest first (SEO-71)", () => {
    const list = [
      row("text", "Notes", "All about apples.", { publishedAt: 1 }),
      row("term", "Notes two", "", { terms: ["Apples"], publishedAt: 2 }),
      row("title", "Apples", "", { publishedAt: 3 }),
      row("old", "Plain", "Apples apples", { publishedAt: 4 }),
      row("new", "Plain", "Apples", { publishedAt: 5 }),
    ];
    expect(ids(list, "apples")).toEqual(["title", "term", "new", "old", "text"]);
  });

  test("SEO-70b: the excerpt is searched and ranks with the category names: below the title, above the text", () => {
    const list = [
      row("text", "Notes", "All about quinces.", { publishedAt: 1 }),
      row("excerpt", "Notes two", "", { excerpt: "Quinces in autumn", publishedAt: 2 }),
      row("title", "Quinces", "", { publishedAt: 3 }),
    ];
    expect(ids(list, "quinces")).toEqual(["title", "excerpt", "text"]);
    expect(ids(list, "autumn")).toEqual(["excerpt"]);
    expect(ids(list, "autum")).toEqual(["excerpt"]);
  });

  test("a whole word ranks above the start of a longer word", () => {
    const list = [row("long", "Bakery"), row("whole", "Bake")];
    expect(ids(list, "bake")).toEqual(["whole", "long"]);
  });

  test("at most eight words count, and an empty query finds nothing", () => {
    expect(ids(rows, "")).toEqual([]);
    expect(ids(rows, "!!! ...")).toEqual([]);
    expect(search(buildIndex(rows), "a b c d e f g h i j").words).toHaveLength(8);
  });

  test("typo help: sourdogh finds sourdough with the corrected words; exact turns it off; far words find nothing", () => {
    const result = search(buildIndex(rows), "sourdogh");
    expect(result.hits.map((h) => h.row.id)).toEqual(["d"]);
    expect(result.corrected).toEqual(["sourdough"]);
    expect(ids(rows, "sourdogh", true)).toEqual([]);
    expect(search(buildIndex(rows), "zzzzzzzz").corrected).toBeNull();
    expect(ids(rows, "zzzzzzzz")).toEqual([]);
    // Short words are not corrected (too many near words).
    expect(ids(rows, "bred")).toEqual([]);
    // A correct word next to a wrong one: only the wrong one changes.
    expect(search(buildIndex(rows), "bread mornin").corrected).toBeNull(); // "mornin" is a start, so it is known
    expect(search(buildIndex(rows), "fresh mornning").corrected).toEqual(["fresh", "morning"]);
  });

  test("a longer word may be two letters off", () => {
    const index = buildIndex([row("x", "Cappuccino menu")]);
    expect(search(index, "cappucinno").corrected).toEqual(["cappuccino"]);
  });
});

describe("the extract", () => {
  test("shows the text around the first match with the matching words marked, and dots where it was cut", () => {
    const text = `${"Lorem ipsum dolor. ".repeat(10)}We sell fresh Bakery goods daily. ${"More words here. ".repeat(10)}`;
    const segments = extractOf(text, ["bakery"]);
    expect(segments.filter((s) => s.mark).map((s) => s.text)).toEqual(["Bakery"]);
    const joined = segments.map((s) => s.text).join("");
    expect(joined.startsWith("…")).toBe(true);
    expect(joined.endsWith("…")).toBe(true);
    expect(joined).toContain("We sell fresh Bakery goods daily.");
    expect(joined.length).toBeLessThan(180);
  });
  test("accents match, and a text without a match starts at the beginning", () => {
    expect(extractOf("Un café noir", ["cafe"]).filter((s) => s.mark)[0]!.text).toBe("café");
    const none = extractOf("Nothing to see.", ["zzz"]);
    expect(none).toEqual([{ text: "Nothing to see.", mark: false }]);
    expect(extractOf("", ["a"])).toEqual([]);
  });
  test("it is plain text pieces, so nothing in the text can become markup", () => {
    const segments = extractOf("<script>alert(1)</script> bakery", ["bakery"]);
    expect(segments.map((s) => s.text).join("")).toContain("<script>");
    expect(segments.every((s) => typeof s.text === "string")).toBe(true);
  });
});

const T = new Date(1_700_000_000_000);
for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: what can be searched (SEO-70)`, () => {
    let db: TestDb;
    let siteId = "";
    let userId = "";

    const add = async (
      slug: string,
      title: string,
      opts: { status?: string; type?: string; seo?: object; meta?: object; at?: number } = {},
    ) => {
      const id = newId();
      await db.run(
        `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, published_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, '{}', '{"version":1,"blocks":[]}', ?, '', ?, ?, ?, ?, ?)`,
        [
          id,
          siteId,
          opts.type ?? "post",
          opts.status ?? "published",
          title,
          slug,
          userId,
          `${title} text about gardens`,
          JSON.stringify(opts.seo ?? {}),
          JSON.stringify(opts.meta ?? {}),
          new Date(opts.at ?? 5_000),
          T,
          T,
        ],
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
          siteName: "S",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      userId = setup.userId;
    });
    afterEach(async () => {
      await db.close();
    });

    test("only published pages and posts count; drafts, private, scheduled, trashed, noindex and hidden entries never do", async () => {
      await add("blog/ok", "Visible post");
      await add("about", "Visible page", { type: "page" });
      await add("blog/draft", "Draft post", { status: "draft" });
      await add("blog/private", "Private post", { status: "private" });
      await add("blog/scheduled", "Scheduled post", { status: "scheduled" });
      await add("blog/trash", "Trashed post", { status: "trash" });
      await add("blog/noindex", "Noindex post", { seo: { noindex: true } });
      await add("blog/hidden", "Hidden post", { meta: { hideFromSearch: true } });
      await add("recipes/x", "Custom type", { type: "recipe" });
      const rows = await loadSearchRows(db.runner, siteId);
      expect(rows.map((r) => r.title).sort()).toEqual(["Visible page", "Visible post"]);
      const index = buildIndex(rows);
      expect(search(index, "gardens").hits).toHaveLength(2);
      expect(search(index, "draft").hits).toHaveLength(0);
    });

    test("SEO-70c: the excerpt (the description in the SEO box) is searched, and a hidden entry's excerpt is not", async () => {
      await add("blog/described", "Plain title", {
        seo: { description: "Rhubarb crumble secrets" },
      });
      await add("blog/hidden-d", "Other title", {
        seo: { description: "Rhubarb tart" },
        meta: { hideFromSearch: true },
      });
      const index = await loadSearchIndex(db.runner, siteId);
      expect(search(index, "rhubarb").hits.map((h) => h.row.title)).toEqual(["Plain title"]);
    });

    test("category and tag names are searchable, and rows come newest first", async () => {
      const older = await add("blog/older", "Older", { at: 1_000 });
      const newer = await add("blog/newer", "Newer", { at: 9_000 });
      const term = newId();
      const taxonomy = String(
        (await db.run("select id from taxonomies where key = 'category'"))[0]!["id"],
      );
      await db.run(
        "insert into terms (id, taxonomy_id, slug, name, description) values (?, ?, 'travel', 'Travel notes', '')",
        [term, taxonomy],
      );
      await db.run("insert into entry_terms (entry_id, term_id, position) values (?, ?, 0)", [
        older,
        term,
      ]);
      const rows = await loadSearchRows(db.runner, siteId);
      expect(rows.map((r) => r.id)).toEqual([newer, older]);
      expect(rows.find((r) => r.id === older)!.terms).toEqual(["Travel notes"]);
      expect(search(buildIndex(rows), "travel").hits.map((h) => h.row.id)).toEqual([older]);
    });

    test("the index is read 500 entries at a time, newest first, with entries that have no publishing time", async () => {
      // 1,203 entries: three batches; some share a time, a few have none (they count from when they were made).
      for (let start = 0; start < 1203; start += 100) {
        const values: unknown[] = [];
        const marks: string[] = [];
        for (let i = start; i < Math.min(start + 100, 1203); i++) {
          marks.push(
            `(?, ?, 'post', 'published', ?, ?, ?, '{}', '{"version":1,"blocks":[]}', ?, '', '{}', '{}', ?, ?, ?)`,
          );
          values.push(
            `ENT${String(i).padStart(23, "0")}`,
            siteId,
            `Entry ${i}`,
            `blog/e${i}`,
            userId,
            i === 1202 ? "sourdough at the end" : "plain words",
            i % 400 === 7 ? null : new Date(1_000_000 + Math.floor(i / 2) * 1000),
            new Date(500),
            T,
          );
        }
        await db.run(
          `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, published_at, created_at, updated_at)
           values ${marks.join(", ")}`,
          values,
        );
      }
      const rows = await loadSearchRows(db.runner, siteId);
      expect(rows).toHaveLength(1203);
      expect(new Set(rows.map((r) => r.id)).size).toBe(1203);
      for (let i = 1; i < rows.length; i++)
        expect(rows[i - 1]!.publishedAt).toBeGreaterThanOrEqual(rows[i]!.publishedAt);
      expect(rows.slice(-3).map((r) => r.publishedAt)).toEqual([500, 500, 500]);
      const index = await loadSearchIndex(db.runner, siteId);
      expect(index.entries).toHaveLength(1203);
      expect(search(index, "sourdough").hits.map((h) => h.row.title)).toEqual(["Entry 1202"]);
      const texts = await loadSearchTexts(db.runner, siteId, [
        `ENT${String(1202).padStart(23, "0")}`,
      ]);
      expect([...texts.values()]).toEqual(["sourdough at the end"]);
      expect(await loadSearchTexts(db.runner, siteId, [])).toEqual(new Map());
    });

    test("the stamp changes when an entry is published, changed, removed or given a term", async () => {
      const first = await searchStamp(db.runner, siteId);
      const id = await add("blog/one", "One");
      const second = await searchStamp(db.runner, siteId);
      expect(second).not.toBe(first);
      await db.run("update entries set updated_at = ? where id = ?", [new Date(9_999_999), id]);
      const third = await searchStamp(db.runner, siteId);
      expect(third).not.toBe(second);
      await db.run("update entries set status = 'draft' where id = ?", [id]);
      expect(await searchStamp(db.runner, siteId)).not.toBe(third);
      expect(MOST_INDEXED).toBeGreaterThan(0);
    });
  });
}
