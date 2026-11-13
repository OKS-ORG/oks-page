// Time zones for the admin (Settings > General). The site has one time zone; times people type (when to publish a page) and
// times the admin shows are in it. The database always holds UTC. These functions use only the browser's and Node's own
// `Intl`, so they work in both and need no library.

/** A time zone name from the standard list ("Asia/Kolkata", "America/New_York", "UTC"). */
export function isValidTimeZone(zone: string): boolean {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The standard list names a few zones by their old names ("Asia/Calcutta" for India). People look for the modern name, and
 * both mean the same zone, so the list shows the modern one.
 */
const MODERN_NAMES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
};

/** Every time zone name, in order, with "UTC" first. */
export function timeZoneNames(): string[] {
  const all =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const names = new Set<string>();
  for (const zone of all) {
    const modern = MODERN_NAMES[zone];
    names.add(modern && isValidTimeZone(modern) ? modern : zone);
  }
  names.delete("UTC");
  return ["UTC", ...[...names].sort()];
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The wall-clock parts of a moment in a zone. */
function partsOf(ms: number, zone: string): Parts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

const asUtc = (p: Parts): number => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** A moment as the value of a date and time box ("2026-11-12T09:30") in the zone. */
export function utcToZonedLocal(ms: number, zone: string): string {
  const p = partsOf(ms, zone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The moment (milliseconds since 1970, UTC) at which the wall clock in `zone` shows this date and time, or null for a
 * value that is not a real date and time. Where a clock change makes the time happen twice (autumn), the earlier moment is
 * taken; where it does not happen at all (spring), the time after the jump is taken.
 */
export function zonedLocalToUtc(local: string, zone: string): number | null {
  const match = LOCAL.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wanted);
  // Refuse dates that roll over (February 30) and times that do not exist on any clock.
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  )
    return null;
  // Start from the zone's offset at that wall time and correct it twice (the offset can change across the guess).
  let ts = wanted;
  for (let i = 0; i < 3; i++) {
    const shown = asUtc(partsOf(ts, zone));
    ts -= shown - wanted;
  }
  // If the clock showed the time twice, the earlier moment is the one an hour before this one.
  const earlier = ts - 60 * 60 * 1000;
  if (asUtc(partsOf(earlier, zone)) === wanted) return earlier;
  return ts;
}

/** A moment written for people ("12 Nov 2026, 9:30 AM") in the zone. */
export function formatInZone(
  ms: number,
  zone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  return new Intl.DateTimeFormat("en", { timeZone: zone, ...options }).format(ms);
}
