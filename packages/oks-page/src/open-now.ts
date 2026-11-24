// "Open now" for the opening hours block (spec 19, section 4): worked out in the visitor's browser from the published hours and
// the business's own time zone, so a page that is cached for hours still says the right thing. Plain functions, so the tests
// can run them at any moment in any time zone without a browser.
import type { HoursDay, HoursProps, HoursSpan, HoursSpecial } from "@oks-page/content-safety";

const NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export type OpenHours = Pick<HoursProps, "tz" | "week" | "special">;

export interface OpenNow {
  open: boolean;
  /** The line to show, in plain words ("Open now, until 17:00"). */
  text: string;
  /** `YYYY-MM-DD` in the business's time zone, and the day of the week (0 is Monday). */
  date: string;
  day: number;
}

/** The date, the day of the week (0 is Monday) and the minutes after midnight in a time zone. */
export function localParts(ms: number, tz: string): { date: string; day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  // The weekday of a calendar date does not depend on a time zone.
  const day = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return { date, day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const clock = (t: string): string => (t === "24:00" ? "00:00" : t);

/** The opening times of one calendar date: its special day if it has one, else the week's times for that day. */
function timesOn(
  h: OpenHours,
  date: string,
  day: number,
): { times: HoursSpan[]; special: HoursSpecial | null } {
  const special = h.special.find((s) => s.date === date) ?? null;
  if (special) return { times: special.times, special };
  const week: HoursDay | undefined = h.week.find((w) => w.day === day);
  return { times: week?.times ?? [], special: null };
}

const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Whether the business is open at a moment, and the words for it. */
export function openNow(h: OpenHours, ms: number): OpenNow {
  const here = localParts(ms, h.tz);
  const today = timesOn(h, here.date, here.day);
  const current = today.times.find(
    (s) => minutesOf(s[0]) <= here.minutes && here.minutes < minutesOf(s[1]),
  );
  if (current) return { open: true, text: `Open now, until ${clock(current[1])}`, ...base(here) };
  // Closed: when does it open next (this day later, or one of the next seven days)?
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const date = addDays(here.date, ahead);
    const day = (here.day + ahead) % 7;
    const { times } = ahead === 0 ? today : timesOn(h, date, day);
    const next = times.find((s) => ahead > 0 || minutesOf(s[0]) > here.minutes);
    if (!next) continue;
    const when = ahead === 0 ? "today" : ahead === 1 ? "tomorrow" : NAMES[day]!;
    const why = today.special?.note && today.times.length === 0 ? ` (${today.special.note})` : "";
    return {
      open: false,
      text: `Closed now${why}, opens ${when} at ${next[0]}`,
      ...base(here),
    };
  }
  return { open: false, text: "Closed now", ...base(here) };
}

const base = (here: { date: string; day: number }) => ({ date: here.date, day: here.day });
