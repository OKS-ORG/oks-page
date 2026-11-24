// What the site knows about a business from the Business plugin's settings (spec 19, section 3), and the LocalBusiness
// structured data it writes into every page (spec 08, section 10). The plugin keeps the details as plain text settings; this
// reads them again, carefully, because the plugin is not trusted with what goes into a page's head.

export const BUSINESS_PLUGIN_ID = "business";

export interface BusinessHours {
  day: number;
  times: [string, string][];
}

export interface BusinessInfo {
  name: string;
  type: string;
  street: string;
  postal: string;
  city: string;
  country: string;
  phone: string;
  email: string;
  /** Addresses of the business's pages elsewhere; https only. */
  social: string[];
  week: BusinessHours[];
  special: { date: string; note: string; times: [string, string][] }[];
}

const SCHEMA_TYPES: Record<string, string> = {
  restaurant: "Restaurant",
  cafe: "CafeOrCoffeeShop",
  "coffee shop": "CafeOrCoffeeShop",
  bar: "BarOrPub",
  pub: "BarOrPub",
  bakery: "Bakery",
  hotel: "Hotel",
  store: "Store",
  shop: "Store",
  "hair salon": "HairSalon",
  hairdresser: "HairSalon",
  "beauty salon": "BeautySalon",
  dentist: "Dentist",
  doctor: "Physician",
  pharmacy: "Pharmacy",
  gym: "ExerciseGym",
  lawyer: "LegalService",
  "law firm": "LegalService",
  accountant: "AccountingService",
  electrician: "Electrician",
  plumber: "Plumber",
  "real estate": "RealEstateAgent",
  florist: "Florist",
  "auto repair": "AutoRepair",
  "car repair": "AutoRepair",
};

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIME = /^(?:[01]?\d|2[0-3]):[0-5]\d$|^24:00$/;
const SPAN = /^\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*$/;

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

const pad = (t: string): string => (t.length === 4 ? `0${t}` : t);
const minutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The opening times written in a setting ("09:00-12:00, 13:00-17:00"): the same reading the plugin does. */
export function parseTimes(text: string): [string, string][] {
  const spans: [string, string][] = [];
  for (const part of clean(text, 200).split(",")) {
    const m = SPAN.exec(part);
    if (!m) continue;
    const from = pad(m[1]!);
    const to = pad(m[2]!);
    if (!TIME.test(from) || !TIME.test(to) || from === "24:00" || minutes(to) <= minutes(from))
      continue;
    spans.push([from, to]);
  }
  return spans;
}

/** The special days written in a setting: the same reading the plugin does. */
export function parseSpecialDays(text: string): BusinessInfo["special"] {
  const out: BusinessInfo["special"] = [];
  for (const item of clean(text, 1500).split(";")) {
    const m =
      /^\s*(\d{4}-\d{2}-\d{2})\s+(closed|(?:\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}\s*,?\s*)+)\s*(.*)$/i.exec(
        item,
      );
    if (!m) continue;
    const date = m[1]!;
    if (
      Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    )
      continue;
    out.push({
      date,
      note: clean(m[3], 80),
      times: m[2]!.toLowerCase() === "closed" ? [] : parseTimes(m[2]!),
    });
  }
  return out;
}

/** The business from the plugin's saved settings, or null when it has no name (nothing to say about it). */
export function readBusiness(values: Record<string, unknown>): BusinessInfo | null {
  const name = clean(values["name"], 120);
  if (!name) return null;
  const week: BusinessHours[] = [];
  for (const [day, key] of DAY_KEYS.entries()) {
    const times = parseTimes(clean(values[`hours_${key}`], 200));
    if (times.length > 0) week.push({ day, times });
  }
  const social = clean(values["social"], 1500)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https:\/\/[^\s"<>]{3,300}$/.test(s))
    .slice(0, 10);
  return {
    name,
    type: clean(values["type"], 60),
    street: clean(values["street"], 120),
    postal: clean(values["postal"], 20),
    city: clean(values["city"], 80),
    country: clean(values["country"], 2)
      .toUpperCase()
      .replace(/[^A-Z]/g, ""),
    phone: clean(values["phone"], 40),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(values["email"], 120))
      ? clean(values["email"], 120)
      : "",
    social,
    week,
    special: parseSpecialDays(clean(values["special_days"], 1500)),
  };
}

/** The `LocalBusiness` structured data of a page (BZ-01): only what the owner entered, in the words search engines read. */
export function localBusinessStructuredData(b: BusinessInfo, origin: string): unknown {
  const type = SCHEMA_TYPES[b.type.toLowerCase()] ?? "LocalBusiness";
  const closes = (t: string) => (t === "24:00" ? "23:59" : t);
  const hours = [
    ...b.week.flatMap((w) =>
      w.times.map(([opens, to]) => ({
        "@type": "OpeningHoursSpecification",
        dayOfWeek: DAY_NAMES[w.day],
        opens,
        closes: closes(to),
      })),
    ),
    ...b.special.flatMap((s) =>
      (s.times.length > 0 ? s.times : ([["00:00", "00:00"]] as [string, string][])).map(
        ([opens, to]) => ({
          "@type": "OpeningHoursSpecification",
          validFrom: s.date,
          validThrough: s.date,
          opens,
          closes: closes(to),
        }),
      ),
    ),
  ];
  const hasAddress = b.street !== "" || b.city !== "";
  return {
    "@context": "https://schema.org",
    "@type": type,
    name: b.name,
    url: `${origin.replace(/\/$/, "")}/`,
    ...(b.phone ? { telephone: b.phone } : {}),
    ...(b.email ? { email: b.email } : {}),
    ...(hasAddress
      ? {
          address: {
            "@type": "PostalAddress",
            ...(b.street ? { streetAddress: b.street } : {}),
            ...(b.postal ? { postalCode: b.postal } : {}),
            ...(b.city ? { addressLocality: b.city } : {}),
            ...(b.country ? { addressCountry: b.country } : {}),
          },
        }
      : {}),
    ...(b.social.length > 0 ? { sameAs: b.social } : {}),
    ...(hours.length > 0 ? { openingHoursSpecification: hours } : {}),
  };
}
