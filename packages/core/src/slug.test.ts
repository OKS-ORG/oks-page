import { describe, expect, test } from "vitest";
import { isSlugPart, slugFromTitle } from "./content.js";
import { cleanPath } from "./redirects.js";

// Spec 08, section 3 (SEO-20 to SEO-22): addresses keep the letters of every script.
describe("an address made from a title", () => {
  test("lower case, one hyphen for any run of other characters, apostrophes removed", () => {
    expect(slugFromTitle("Hello, World! It's 2026")).toBe("hello-world-its-2026");
    expect(slugFromTitle("Anna’s   Garden")).toBe("annas-garden");
    expect(slugFromTitle("  --Tom & Jerry--  ")).toBe("tom-jerry");
  });

  test("accents are kept, whichever way the accent was typed", () => {
    expect(slugFromTitle("Café Münster")).toBe("café-münster");
    // The same words with the accents typed as separate marks give the same address.
    expect(slugFromTitle("Café Münster")).toBe("café-münster");
    expect(slugFromTitle("Crème brûlée  recipe")).toBe("crème-brûlée-recipe");
  });

  test("Hindi keeps its vowel signs (the first version cut the word apart)", () => {
    expect(slugFromTitle("नमस्ते दुनिया")).toBe("नमस्ते-दुनिया");
    expect(slugFromTitle("हिन्दी में लिखें!")).toBe("हिन्दी-में-लिखें");
  });

  test("other scripts: Arabic, Chinese, Greek, Cyrillic", () => {
    expect(slugFromTitle("مكتبة المدينة")).toBe("مكتبة-المدينة");
    expect(slugFromTitle("你好 世界")).toBe("你好-世界");
    expect(slugFromTitle("ΑΘΗΝΑ Ελλάδα")).toBe("αθηνα-ελλάδα");
    expect(slugFromTitle("Привет, Мир")).toBe("привет-мир");
  });

  test("a title with nothing usable gives untitled", () => {
    for (const title of ["", "   ", "???", "--", "😀 😀", "!@#$%"])
      expect(slugFromTitle(title), JSON.stringify(title)).toBe("untitled");
  });

  test("at most 80 characters, never a hyphen at the end, never half of a letter", () => {
    const long = slugFromTitle("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("-")).toBe(false);
    const hindi = slugFromTitle("नमस्ते ".repeat(30));
    expect([...hindi].length).toBeLessThanOrEqual(80);
    expect(hindi.endsWith("-")).toBe(false);
    // 𠮷 is one letter made of two code units: the cut must not split it.
    const rare = slugFromTitle("𠮷".repeat(100));
    expect([...rare]).toHaveLength(80);
    expect(rare).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
  });

  test("whatever it makes, the site accepts", () => {
    for (const title of [
      "Hello, World!",
      "Café Münster",
      "नमस्ते दुनिया",
      "مكتبة المدينة",
      "你好 世界",
      "İstanbul",
      "ΑΘΗΝΑ",
      "𠮷野家",
      "word ".repeat(40),
    ])
      expect(isSlugPart(slugFromTitle(title)), title).toBe(true);
  });
});

describe("what the site accepts as an address part", () => {
  test("letters, marks and numbers of any script, joined by single hyphens", () => {
    for (const ok of [
      "about",
      "2026",
      "a-b",
      "café-münster",
      "नमस्ते-दुनिया",
      "你好-世界",
      "مكتبة",
    ])
      expect(isSlugPart(ok), ok).toBe(true);
  });
  test("not: upper case, the decomposed form, doubled or edge hyphens, spaces, slashes and other symbols", () => {
    for (const bad of [
      "",
      "Café",
      "ABC",
      "café", // the accent as a separate mark: only the composed form is stored
      "a--b",
      "-a",
      "a-",
      "a b",
      "a/b",
      "a_b",
      "a.b",
      "a%20b",
      "a‮b", // a right-to-left override would make the address look like something else
      "a​b", // a zero-width space
      "<b>",
    ])
      expect(isSlugPart(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("redirect paths are stored in the same form", () => {
  test("a path typed with separate accent marks is the composed path", () => {
    expect(cleanPath("/café/")).toBe("/café");
    expect(cleanPath("/नमस्ते/")).toBe("/नमस्ते");
  });
});
