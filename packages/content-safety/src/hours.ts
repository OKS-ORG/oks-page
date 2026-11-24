// The opening hours block (spec 19, section 4): the weekly hours of a business and its special days, in the business's own
// time zone. A plugin's block returns it. Everything about it is read here, once, for the block checks and for the HTML
// writer, so both agree: only real times, real days, a real time zone and a sensible amount of text are kept.

/** Day 0 is Monday, as in most of the countries that ask for opening hours. */
export const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** One opening time of a day: `[from, to]` as `HH:MM`, with `to` later than `from` (a day that ends at midnight uses 24:00). */
export type HoursSpan = [string, string];

export interface HoursDay {
  day: number;
  times: HoursSpan[];
}

export interface HoursSpecial {
  /** `YYYY-MM-DD`, a real calendar day. */
  date: string;
  /** What it is ("Christmas Day"), up to 80 characters. Empty when there is nothing to say. */
  note: string;
  /** Empty means closed that day. */
  times: HoursSpan[];
}

export interface HoursProps {
  title: string;
  /** An IANA time zone name such as `Europe/Berlin`. */
  tz: string;
  week: HoursDay[];
  special: HoursSpecial[];
}

export const HOURS_KEYS = ["title", "tz", "week", "special"] as const;
export const MOST_SPANS = 4;
export const MOST_SPECIAL = 60;

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = (value: unknown, max: number): string => {
  if (typeof value !== "string") return "";
  // Control characters become spaces.
  return Array.from(value, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
};

/** Minutes after midnight for an `HH:MM` time. */
export const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** True for a time zone name the platform knows. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The opening times of one day: valid spans only, the latest first dropped when they overlap, in time order, at most 4. */
function spansOf(raw: unknown): HoursSpan[] {
  const spans: HoursSpan[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [from, to] = item as unknown[];
    if (typeof from !== "string" || typeof to !== "string") continue;
    if (!TIME.test(from) || !TIME.test(to) || from === "24:00") continue;
    if (minutesOf(to) <= minutesOf(from)) continue;
    spans.push([from, to]);
  }
  spans.sort((a, b) => minutesOf(a[0]) - minutesOf(b[0]));
  const out: HoursSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && minutesOf(s[0]) < minutesOf(last[1])) continue;
    if (out.length >= MOST_SPANS) break;
    out.push(s);
  }
  return out;
}

/** True for a real calendar day written `YYYY-MM-DD`. */
export function isRealDate(date: string): boolean {
  if (!DATE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/**
 * The hours a block's props describe, cleaned, or null when there is nothing safe to draw (no real time zone, or no opening
 * time on any day and no special day). A day that is listed twice keeps its first entry.
 */
export function readHours(raw: Record<string, unknown>): HoursProps | null {
  if (!isTimeZone(raw["tz"])) return null;
  const week: HoursDay[] = [];
  const days = new Set<number>();
  for (const item of Array.isArray(raw["week"]) ? raw["week"] : []) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const d = item as Record<string, unknown>;
    const day = d["day"];
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6 || days.has(day))
      continue;
    days.add(day);
    const times = spansOf(d["times"]);
    if (times.length > 0) week.push({ day, times });
  }
  week.sort((a, b) => a.day - b.day);
  const special: HoursSpecial[] = [];
  const dates = new Set<string>();
  for (const item of Array.isArray(raw["special"]) ? raw["special"] : []) {
    if (special.length >= MOST_SPECIAL) break;
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const s = item as Record<string, unknown>;
    const date = typeof s["date"] === "string" ? s["date"] : "";
    if (!isRealDate(date) || dates.has(date)) continue;
    dates.add(date);
    special.push({ date, note: text(s["note"], 80), times: spansOf(s["times"]) });
  }
  special.sort((a, b) => a.date.localeCompare(b.date));
  if (week.length === 0 && special.length === 0) return null;
  return { title: text(raw["title"], 80), tz: raw["tz"], week, special };
}
