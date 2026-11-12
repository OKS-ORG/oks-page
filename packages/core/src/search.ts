// Site search (spec 08, section 16). Matching runs in the application on a small in-memory index, so it gives the same
// answers on SQLite and PostgreSQL. It ignores case and accents, matches the start of the last word typed ("bake" finds
// "bakery"), ranks a title match above a category or tag match above a text match (equal ones: newest first), and helps
// with typos ("sourdogh" finds "sourdough"). Meant for sites of up to a few thousand entries; a database-native engine
// for bigger sites comes later.
import type { SqlRunner } from "@oks-page/db";

export interface SearchRow {
  id: string;
  title: string;
  /** The whole address path ("blog/hello-world"). */
  slug: string;
  type: string;
  publishedAt: number;
  text: string;
  /** The names of the entry's categories and tags. */
  terms: string[];
}

interface Doc {
  row: SearchRow;
  title: Set<string>;
  terms: Set<string>;
  text: Set<string>;
}

export interface SearchIndex {
  docs: Doc[];
  /** Every word on the site and how many entries it is in (for typo help). */
  vocabulary: Map<string, number>;
}

/** Lower case, and the marks that sit on letters (accents, Arabic vowel signs) taken off. */
export const normalize = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ًͯ-ٰٟ]/g, "")
    .toLowerCase();

// Marks belong to the word (the vowel signs of Hindi and other scripts); the ones on Latin letters are taken off before.
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
export const wordsOf = (text: string): string[] => normalize(text).match(WORD) ?? [];

const MOST_WORDS = 8;
const TEXT_LIMIT = 20_000;
/** The most entries in the index: the newest ones. */
export const MOST_INDEXED = 5000;

export function buildIndex(rows: SearchRow[]): SearchIndex {
  const vocabulary = new Map<string, number>();
  const docs = rows.map((row): Doc => {
    const title = new Set(wordsOf(row.title));
    const terms = new Set(row.terms.flatMap((t) => wordsOf(t)));
    const text = new Set(wordsOf(row.text.slice(0, TEXT_LIMIT)));
    for (const word of new Set([...title, ...terms, ...text]))
      vocabulary.set(word, (vocabulary.get(word) ?? 0) + 1);
    return { row, title, terms, text };
  });
  return { docs, vocabulary };
}

/** How well a word is in a set of words: 1 as a whole word, 0.6 as the start of a longer word, 0 not at all. */
function strength(set: Set<string>, word: string, prefix: boolean): number {
  if (set.has(word)) return 1;
  if (prefix) for (const token of set) if (token.startsWith(word)) return 0.6;
  return 0;
}

const WEIGHT = { title: 100, terms: 30, text: 10 } as const;

export interface Hit {
  row: SearchRow;
  score: number;
}

function find(index: SearchIndex, words: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const doc of index.docs) {
    let score = 0;
    let all = true;
    for (let i = 0; i < words.length && all; i++) {
      const word = words[i]!;
      const prefix = i === words.length - 1; // only the last word typed may be unfinished
      const best = Math.max(
        strength(doc.title, word, prefix) * WEIGHT.title,
        strength(doc.terms, word, prefix) * WEIGHT.terms,
        strength(doc.text, word, prefix) * WEIGHT.text,
      );
      if (best === 0) all = false;
      else score += best;
    }
    if (all) hits.push({ row: doc.row, score });
  }
  return hits.sort(
    (a, b) =>
      b.score - a.score || b.row.publishedAt - a.row.publishedAt || (a.row.id < b.row.id ? -1 : 1),
  );
}

function distance(a: string, b: string, most: number): number {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let smallest = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      row.push(value);
      if (value < smallest) smallest = value;
    }
    if (smallest > most) return most + 1;
    previous = row;
  }
  return previous[b.length]!;
}

/** The nearest word on the site: at most 1 letter different for words of 5 to 8 letters, 2 for longer ones. */
function nearest(index: SearchIndex, word: string): string | null {
  const most = word.length >= 9 ? 2 : word.length >= 5 ? 1 : 0;
  if (most === 0) return null;
  let best: string | null = null;
  let bestDistance = most + 1;
  let bestCount = 0;
  for (const [candidate, count] of index.vocabulary) {
    const d = distance(word, candidate, most);
    if (d < bestDistance || (d === bestDistance && count > bestCount)) {
      best = candidate;
      bestDistance = d;
      bestCount = count;
    }
  }
  return bestDistance <= most ? best : null;
}

export interface SearchResult {
  /** The words searched (as typed, normalised). */
  words: string[];
  hits: Hit[];
  /** When the typed words found nothing and a near spelling did: the words used instead. */
  corrected: string[] | null;
}

/**
 * Searches the index. `exact` turns typo help off (the "search exactly as typed" link). At most eight words count;
 * a query with no words finds nothing.
 */
export function search(index: SearchIndex, query: string, exact = false): SearchResult {
  const words = wordsOf(query).slice(0, MOST_WORDS);
  if (words.length === 0) return { words, hits: [], corrected: null };
  const hits = find(index, words);
  if (hits.length > 0 || exact) return { words, hits, corrected: null };
  // Nothing found: try the nearest words that exist on the site for the words that are not there at all.
  const fixed = words.map((w, i) => {
    const known =
      index.vocabulary.has(w) ||
      (i === words.length - 1 && [...index.vocabulary.keys()].some((k) => k.startsWith(w)));
    return known ? w : (nearest(index, w) ?? w);
  });
  if (fixed.every((w, i) => w === words[i])) return { words, hits: [], corrected: null };
  const again = find(index, fixed);
  return again.length > 0
    ? { words, hits: again, corrected: fixed }
    : { words, hits: [], corrected: null };
}

export interface Segment {
  text: string;
  mark: boolean;
}

/** A short piece of the text around the first match, with the matching words marked. */
export function extractOf(text: string, queryWords: string[], width = 160): Segment[] {
  const tokens = [...text.matchAll(WORD)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
    word: normalize(m[0]),
  }));
  const matches = (word: string) => queryWords.some((q) => word === q || word.startsWith(q));
  const first = tokens.find((t) => matches(t.word));
  const from = first ? Math.max(0, first.start - 50) : 0;
  const to = Math.min(text.length, from + width);
  const segments: Segment[] = [];
  let at = from;
  for (const t of tokens) {
    if (t.end <= from || t.start >= to) continue;
    if (!matches(t.word)) continue;
    if (t.start > at) segments.push({ text: text.slice(at, t.start), mark: false });
    segments.push({ text: text.slice(t.start, t.end), mark: true });
    at = t.end;
  }
  if (at < to) segments.push({ text: text.slice(at, to), mark: false });
  if (segments.length > 0) {
    if (from > 0) segments[0] = { ...segments[0]!, text: "…" + segments[0]!.text };
    if (to < text.length) {
      const last = segments[segments.length - 1]!;
      segments[segments.length - 1] = { ...last, text: last.text + "…" };
    }
  }
  return segments;
}

const toNumber = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

const asObject = (raw: unknown): Record<string, unknown> => {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
};

/**
 * What can be found: published pages and posts, the newest 5,000. Left out: drafts, private, scheduled and trashed
 * entries, entries set to `noindex` and entries with "Hide from site search" (`meta.hideFromSearch`).
 */
export async function loadSearchRows(runner: SqlRunner, siteId: string): Promise<SearchRow[]> {
  const entries = await runner.all(
    `select "id", "title", "slug", "type_key", "plain_text", "published_at", "seo", "meta" from "entries"
      where "site_id" = ? and "status" = 'published' and "locale" = '' and "type_key" in ('page', 'post')
      order by "published_at" desc, "id" limit ${MOST_INDEXED}`,
    [siteId],
  );
  const terms = await runner.all(
    `select et."entry_id", t."name" from "entry_terms" et join "terms" t on t."id" = et."term_id"
       join "taxonomies" x on x."id" = t."taxonomy_id" where x."site_id" = ?`,
    [siteId],
  );
  const byEntry = new Map<string, string[]>();
  for (const r of terms) {
    const id = String(r["entry_id"]);
    byEntry.set(id, [...(byEntry.get(id) ?? []), String(r["name"])]);
  }
  const rows: SearchRow[] = [];
  for (const e of entries) {
    if (asObject(e["seo"])["noindex"] === true || asObject(e["meta"])["hideFromSearch"] === true)
      continue;
    const id = String(e["id"]);
    rows.push({
      id,
      title: String(e["title"]),
      slug: String(e["slug"]),
      type: String(e["type_key"]),
      publishedAt: toNumber(e["published_at"]),
      text: String(e["plain_text"]),
      terms: byEntry.get(id) ?? [],
    });
  }
  return rows;
}

/** A cheap fingerprint of what the index is made of: it changes when an entry is published, changed or removed. */
export async function searchStamp(runner: SqlRunner, siteId: string): Promise<string> {
  const rows = await runner.all(
    `select count(*) as "n", max("updated_at") as "latest" from "entries"
      where "site_id" = ? and "status" = 'published' and "locale" = '' and "type_key" in ('page', 'post')`,
    [siteId],
  );
  const terms = await runner.all(
    `select count(*) as "n" from "entry_terms" et join "terms" t on t."id" = et."term_id"
       join "taxonomies" x on x."id" = t."taxonomy_id" where x."site_id" = ?`,
    [siteId],
  );
  return `${Number(rows[0]?.["n"])}:${toNumber(rows[0]?.["latest"])}:${Number(terms[0]?.["n"])}`;
}
