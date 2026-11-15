import { describe, expect, test } from "vitest";
import { buildIndex, extractOf, normalize, search, type SearchRow } from "./search.js";
import { formKeysOf } from "./word-forms.js";

const meet = (a: string, b: string, language: string) => {
  const keys = new Set(formKeysOf(normalize(a), language));
  return formKeysOf(normalize(b), language).some((k) => keys.has(k));
};
const row = (id: string, title: string, text = "", at = 1000): SearchRow => ({
  id,
  title,
  slug: `blog/${id}`,
  type: "post",
  publishedAt: at,
  text,
  terms: [],
});

describe("word forms (SEO-72)", () => {
  test("English: a plural and its singular meet", () => {
    for (const [a, b] of [
      ["loaves", "loaf"],
      ["knives", "knife"],
      ["olives", "olive"],
      ["berries", "berry"],
      ["boxes", "box"],
      ["dishes", "dish"],
      ["horses", "horse"],
      ["cakes", "cake"],
    ])
      expect(meet(a!, b!, "en"), `${a} and ${b}`).toBe(true);
  });
  test("English: words that only look like plurals are left alone", () => {
    expect(formKeysOf("glass", "en")).toEqual(["glass"]);
    expect(formKeysOf("virus", "en")).toEqual(["virus"]);
    expect(formKeysOf("basis", "en")).toEqual(["basis"]);
    expect(formKeysOf("series", "en")).toEqual(["series", "serie"]);
    expect(formKeysOf("bus", "en")).toEqual(["bus"]);
    expect(meet("bread", "breakfast", "en")).toBe(false);
  });
  test("German: a plural and its singular meet (umlauts are already gone)", () => {
    for (const [a, b] of [
      ["Brote", "Brot"],
      ["Bücher", "Buch"],
      ["Gärten", "Garten"],
      ["Kindern", "Kind"],
      ["Hunde", "Hund"],
      ["Autos", "Auto"],
      ["Äpfel", "Apfel"],
    ])
      expect(meet(a!, b!, "de"), `${a} and ${b}`).toBe(true);
  });
  test("languages without word forms match whole words only; English rules do not apply in German and back", () => {
    expect(meet("loaves", "loaf", "fr")).toBe(false);
    expect(meet("loaves", "loaf", "de")).toBe(false);
    expect(meet("Brote", "Brot", "en")).toBe(false);
    expect(meet("loaves", "loaf", "en-GB")).toBe(true);
  });
});

describe("Arabic (SEO-76)", () => {
  test("the article is ignored, also after و ف ب ك ل; vowel marks are ignored", () => {
    expect(meet("المكتبة", "مكتبة", "ar")).toBe(true);
    expect(meet("والمكتبة", "مكتبة", "ar")).toBe(true);
    expect(meet("بالمكتبة", "المكتبة", "ar")).toBe(true);
    expect(meet("للمكتبة", "مكتبة", "ar")).toBe(true);
    expect(meet("مَكْتَبَة", "المكتبة", "ar")).toBe(true);
    // In any site language: the article belongs to the script, not to the site.
    expect(meet("المكتبة", "مكتبة", "en")).toBe(true);
    // A word that is only the article and one letter is left alone.
    expect(formKeysOf("الم", "ar")).toEqual(["الم"]);
  });
  test("search and the extract: the article and vowel marks match; word forms (plurals) do not, as in static mode", () => {
    const index = buildIndex(
      [
        row("a", "زيارة المكتبة", "قضينا يوما في المكتبة"),
        row("b", "مكتبة صغيرة", "مكتبة الحي"),
        row("c", "مكتبات المدينة", "عدة مكتبات"),
      ],
      "ar",
    );
    expect(
      search(index, "مكتبة")
        .hits.map((h) => h.row.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(
      search(index, "المكتبة")
        .hits.map((h) => h.row.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(
      search(index, "مَكْتَبَة")
        .hits.map((h) => h.row.id)
        .sort(),
    ).toEqual(["a", "b"]);
    const marked = extractOf("قضينا يوما في المكتبة", ["مكتبة"], 160, "ar").filter((s) => s.mark);
    expect(marked.map((s) => s.text)).toEqual(["المكتبة"]);
  });
});

describe("search with word forms", () => {
  test("English: loaves finds loaf and back; the word as typed ranks above another form", () => {
    const index = buildIndex(
      [
        row("one", "A loaf of rye", "", 1000),
        row("many", "Six loaves", "", 2000),
        row("x", "Rye flour", "", 3000),
      ],
      "en",
    );
    expect(search(index, "loaves").hits.map((h) => h.row.id)).toEqual(["many", "one"]);
    expect(search(index, "loaf").hits.map((h) => h.row.id)).toEqual(["one", "many"]);
    // Without word forms (a language that has none), only the word itself.
    expect(
      search(
        buildIndex([row("one", "A loaf"), row("many", "Six loaves")], "fr"),
        "loaves",
      ).hits.map((h) => h.row.id),
    ).toEqual(["many"]);
  });
  test("German: Brote finds Brot; the extract marks the other form", () => {
    const index = buildIndex([row("a", "Unser Brot", "Ein Brot aus Roggen")], "de");
    expect(search(index, "Brote").hits.map((h) => h.row.id)).toEqual(["a"]);
    expect(
      extractOf("Ein Brot aus Roggen", ["brote"], 160, "de")
        .filter((s) => s.mark)
        .map((s) => s.text),
    ).toEqual(["Brot"]);
  });
  test("a word found by another form needs no typo help, and forms are never offered as spelling", () => {
    const index = buildIndex([row("a", "Knives and forks")], "en");
    const found = search(index, "knife");
    expect(found.corrected).toBeNull();
    expect(found.hits.map((h) => h.row.id)).toEqual(["a"]);
    const typo = search(index, "forkss");
    expect(typo.corrected).toEqual(["forks"]);
  });
});
