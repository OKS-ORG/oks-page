// Site search (spec 08, section 16). Matching runs in the application on a compact in-memory index (each word with the
// entries it is in), so it gives the same answers on SQLite and PostgreSQL. It ignores case and accents, matches the start
// of the last word typed ("bake" finds "bakery"), ranks a title match above a category or tag match above a text match
// (equal ones: newest first), and helps with typos ("sourdogh" finds "sourdough"). The index keeps no texts; 10,000 entries
// answer well under 200 ms (SEO-74).
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
export const MOST_INDEXED = 20_000;

/** What the index keeps of an entry: no text (the extracts of the results shown are read from the database). */
export interface SearchEntry {
  id: string;
  title: string;
  slug: string;
  type: string;
  publishedAt: number;
}

/**
 * The index: each word on the site with the entries it is in. `words` is sorted (so the start of a word is a range) and
 * `postings[i]` lists the entries with `words[i]` as `entry * 8 + where`, where is 4 (title), 2 (category or tag), 1 (text)
 * added up. About 4 bytes for each different word of each entry, so 10,000 long posts fit in tens of megabytes.
 */
export interface SearchIndex {
  entries: SearchEntry[];
  words: string[];
  postings: Int32Array[];
}

const IN_TITLE = 4;
const IN_TERMS = 2;
const IN_TEXT = 1;

/** Builds an index entry by entry, so the texts never all sit in memory at once. */
export class SearchIndexBuilder {
  private entries: SearchEntry[] = [];
  private ids = new Map<string, number>();
  private lists: number[][] = [];
  private names: string[] = [];

  add(row: SearchRow): void {
    const doc = this.entries.length;
    this.entries.push({
      id: row.id,
      title: row.title,
      slug: row.slug,
      type: row.type,
      publishedAt: row.publishedAt,
    });
    const where = new Map<string, number>();
    const mark = (words: string[], bit: number) => {
      for (const w of words) where.set(w, (where.get(w) ?? 0) | bit);
    };
    mark(wordsOf(row.title), IN_TITLE);
    mark(
      row.terms.flatMap((t) => wordsOf(t)),
      IN_TERMS,
    );
    mark(wordsOf(row.text.slice(0, TEXT_LIMIT)), IN_TEXT);
    for (const [word, bits] of where) {
      let id = this.ids.get(word);
      if (id === undefined) {
        id = this.names.length;
        this.ids.set(word, id);
        this.names.push(word);
        this.lists.push([]);
      }
      this.lists[id]!.push(doc * 8 + bits);
    }
  }

  finish(): SearchIndex {
    const order = this.names
      .map((_, i) => i)
      .sort((a, b) => (this.names[a]! < this.names[b]! ? -1 : 1));
    const index: SearchIndex = {
      entries: this.entries,
      words: order.map((i) => this.names[i]!),
      postings: order.map((i) => Int32Array.from(this.lists[i]!)),
    };
    this.lists = [];
    this.ids.clear();
    return index;
  }
}

export function buildIndex(rows: SearchRow[]): SearchIndex {
  const builder = new SearchIndexBuilder();
  for (const row of rows) builder.add(row);
  return builder.finish();
}

/** The first place in the sorted words that is not before `word`. */
function lowerBound(words: string[], word: string): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (words[mid]! < word) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const WEIGHT = { title: 100, terms: 30, text: 10 } as const;
const weightOf = (bits: number) =>
  bits & IN_TITLE ? WEIGHT.title : bits & IN_TERMS ? WEIGHT.terms : WEIGHT.text;

export interface Hit {
  row: SearchEntry;
  score: number;
}

function find(index: SearchIndex, words: string[]): Hit[] {
  const n = index.entries.length;
  const score = new Float64Array(n);
  const best = new Float64Array(n);
  let alive: Uint8Array | null = null;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    best.fill(0);
    const apply = (list: Int32Array, factor: number) => {
      for (let k = 0; k < list.length; k++) {
        const v = list[k]!;
        const doc = v >>> 3;
        const s = weightOf(v & 7) * factor;
        if (s > best[doc]!) best[doc] = s;
      }
    };
    // A whole word counts 1; the start of a longer word 0.6 (only the last word typed may be unfinished).
    let at = lowerBound(index.words, word);
    if (index.words[at] === word) apply(index.postings[at++]!, 1);
    if (i === words.length - 1)
      for (; at < index.words.length && index.words[at]!.startsWith(word); at++)
        apply(index.postings[at]!, 0.6);
    const next = new Uint8Array(n);
    for (let doc = 0; doc < n; doc++)
      if (best[doc]! > 0 && (alive === null || alive[doc] === 1)) {
        next[doc] = 1;
        score[doc] = score[doc]! + best[doc]!;
      }
    alive = next;
  }
  const hits: Hit[] = [];
  for (let doc = 0; doc < n; doc++)
    if (alive?.[doc] === 1) hits.push({ row: index.entries[doc]!, score: score[doc]! });
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
  for (let i = 0; i < index.words.length; i++) {
    const candidate = index.words[i]!;
    if (Math.abs(candidate.length - word.length) > most) continue;
    const d = distance(word, candidate, most);
    const count = index.postings[i]!.length;
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
    const at = lowerBound(index.words, w);
    const known =
      index.words[at] === w || (i === words.length - 1 && (index.words[at] ?? "").startsWith(w));
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
 * What can be found: published pages and posts, the newest 20,000. Left out: drafts, private, scheduled and trashed
 * entries, entries set to `noindex` and entries with "Hide from site search" (`meta.hideFromSearch`).
 */
export async function loadSearchRows(runner: SqlRunner, siteId: string): Promise<SearchRow[]> {
  const rows: SearchRow[] = [];
  await eachSearchRow(runner, siteId, (row) => void rows.push(row));
  return rows;
}

const BATCH = 500;

/** The rows of `loadSearchRows`, one by one, read 500 at a time so the texts never all sit in memory. */
export async function eachSearchRow(
  runner: SqlRunner,
  siteId: string,
  use: (row: SearchRow) => void,
): Promise<void> {
  const terms = await loadTermNames(runner, siteId);
  let after: { at: Date; id: string } | null = null;
  for (let read = 0; read < MOST_INDEXED;) {
    // Newest first; an entry without a publishing time (imported) counts from when it was made.
    const entries = await runner.all(
      `select "id", "title", "slug", "type_key", "plain_text", "seo", "meta",
          coalesce("published_at", "created_at") as "at" from "entries"
        where "site_id" = ? and "status" = 'published' and "locale" = '' and "type_key" in ('page', 'post')
        ${after ? `and (coalesce("published_at", "created_at") < ? or (coalesce("published_at", "created_at") = ? and "id" > ?))` : ""}
        order by coalesce("published_at", "created_at") desc, "id" limit ${Math.min(BATCH, MOST_INDEXED - read)}`,
      after ? [siteId, after.at, after.at, after.id] : [siteId],
    );
    for (const row of searchRowsOf(entries, terms)) use(row);
    read += entries.length;
    if (entries.length < BATCH) break;
    const last = entries[entries.length - 1]!;
    after = { at: new Date(toNumber(last["at"])), id: String(last["id"]) };
  }
}

/** Builds the site's index from the database, 500 entries at a time. */
export async function loadSearchIndex(runner: SqlRunner, siteId: string): Promise<SearchIndex> {
  const builder = new SearchIndexBuilder();
  await eachSearchRow(runner, siteId, (row) => builder.add(row));
  return builder.finish();
}

/** The texts of a few entries (the results shown), for their extracts. */
export async function loadSearchTexts(
  runner: SqlRunner,
  siteId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await runner.all(
    `select "id", "plain_text" from "entries" where "site_id" = ? and "id" in (${ids.map(() => "?").join(", ")})`,
    [siteId, ...ids],
  );
  return new Map(rows.map((r) => [String(r["id"]), String(r["plain_text"] ?? "")]));
}

async function loadTermNames(runner: SqlRunner, siteId: string): Promise<Map<string, string[]>> {
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
  return byEntry;
}

function searchRowsOf(
  entries: Record<string, unknown>[],
  byEntry: Map<string, string[]>,
): SearchRow[] {
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
      publishedAt: toNumber(e["at"]),
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
