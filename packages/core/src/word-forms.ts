// Word forms for site search (spec 08, section 16.2, point 3; SEO-72, SEO-76). Light rules, the same for the index and the
// query, so a plural finds its singular: English "loaves" and "loaf", "boxes" and "box"; German "Brote" and "Brot",
// "Bücher" and "Buch" (the umlaut is already gone after `normalize`). For Arabic the article is ignored in any site
// language ("الكتاب" and "كتاب"), as Pagefind does in static mode (spec 12, section 10); vowel marks are already ignored.
// Words are given already normalised (lower case, no accents). The rules only ever shorten a word: a form is never longer
// than the word, and words of three letters or fewer are left alone.

/** The site languages that have word forms. Others match whole words and the start of words only. */
export const WORD_FORM_LANGUAGES = ["en", "de"] as const;

const ARABIC = /^[؀-ۿ]/;
// The article, alone or after the prepositions and conjunctions written onto it (و ف ب ك ل).
const ARABIC_ARTICLE = /^(?:[وفبك]?ال|لل)/;

function arabicForms(word: string): string[] {
  const rest = word.replace(ARABIC_ARTICLE, "");
  return rest !== word && rest.length >= 2 ? [rest] : [];
}

function englishForms(word: string): string[] {
  const n = word.length;
  if (n <= 3) return [];
  // loaves, knives, wives → loaf, knif(e), wif(e); olives → olive
  if (word.endsWith("ves") && n > 4) return [word.slice(0, -3) + "f", word.slice(0, -1)];
  if (word.endsWith("fe")) return [word.slice(0, -2) + "f"];
  // berries → berry (but not series, species)
  if (word.endsWith("ies") && n > 4 && !/(?:er|ec)ies$/.test(word))
    return [word.slice(0, -3) + "y"];
  // boxes, dishes, churches, buses → box, dish, church, bus; horses → horse
  if (/(?:s|x|z|ch|sh)es$/.test(word) && n > 4) return [word.slice(0, -2), word.slice(0, -1)];
  // cakes → cake; not glass, virus, basis
  if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) return [word.slice(0, -1)];
  return [];
}

function germanForms(word: string): string[] {
  let w = word;
  const n = () => w.length;
  // The endings of plurals and cases: Gärten, Kindern, Brote, Hunden, Bücher, Autos.
  if (n() > 5 && w.endsWith("ern")) w = w.slice(0, -3);
  else if (n() > 4 && /(?:em|en|er|es)$/.test(w)) w = w.slice(0, -2);
  else if (n() > 3 && /[esn]$/.test(w)) w = w.slice(0, -1);
  // The singular too: Garten and Gärten, Buch and Bücher end up the same.
  return w !== word ? [w] : [];
}

/** The other forms a word is found by (none for most words). */
export function formsOf(word: string, language: string): string[] {
  if (ARABIC.test(word)) return arabicForms(word);
  const base = language.split("-")[0];
  if (base === "en") return englishForms(word);
  if (base === "de") return germanForms(word);
  return [];
}

/**
 * The keys a word is found by: itself and its forms. Two words match by form when they share a key ("loaves": loaves, loaf,
 * loave; "loaf": loaf).
 */
export function formKeysOf(word: string, language: string): string[] {
  return [word, ...formsOf(word, language).filter((f) => f !== word)];
}
