// What a plugin says about the personal data it keeps (spec 18, section 5): where in its own storage a person's data is,
// how to recognise it (an email address in one of the fields), and what to show the owner about each item. The site's
// privacy tool then finds, exports and deletes the items itself; no plugin code runs. Nothing here runs code.
import { FIELD_PATH, collectionOf } from "./admin-pages.js";

export const PERSONAL_DATA_MOST = 5;

/** One thing the owner sees about an item found for a person. */
export interface PersonalDataColumn {
  field: string;
  label: string;
  /** `datetime` reads a number of milliseconds (or a date text). Default `text`. */
  format?: "text" | "datetime";
}

/** One collection of a plugin's storage that holds data about people. */
export interface PersonalDataSource {
  id: string;
  /** What the owner reads in the list ("Form messages"). */
  label: string;
  /** `storage:<collection>`. */
  source: string;
  /** The fields that hold an email address, as text or as a list of texts. An item belongs to a person when one of them equals
   * the person's address (capitals and surrounding spaces do not matter). */
  match: string[];
  /** What to show about each item found (at most 6). Default: when it was saved. */
  show: PersonalDataColumn[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max ? v : null;

/** The personal data a manifest declares, or the words for what is wrong with it. */
export function readPersonalData(value: unknown): PersonalDataSource[] | string {
  if (!Array.isArray(value)) return "The plugin's personalData must be a list.";
  if (value.length > PERSONAL_DATA_MOST)
    return "The plugin declares too many kinds of personal data.";
  const out: PersonalDataSource[] = [];
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const bad = (why: string) =>
      `The personal data "${String(r["id"] ?? "").slice(0, 40)}" is not valid: ${why}`;
    const id = r["id"];
    if (typeof id !== "string" || !ID.test(id))
      return bad("its id must be lower-case letters, digits and hyphens.");
    if (seen.has(id)) return bad("its id is used twice.");
    seen.add(id);
    const label = text(r["label"], 80);
    if (label === null) return bad("it needs a label of at most 80 characters.");
    if (typeof r["source"] !== "string" || collectionOf(r["source"]) === null)
      return bad('its source must look like "storage:messages".');
    const match = r["match"];
    if (!Array.isArray(match) || match.length < 1 || match.length > 3)
      return bad("it needs 1 to 3 fields that hold an email address.");
    for (const f of match as unknown[])
      if (typeof f !== "string" || !FIELD_PATH.test(f) || f.startsWith("$"))
        return bad("an email field is not a valid field name.");
    const show: PersonalDataColumn[] = [];
    if (r["show"] !== undefined) {
      if (!Array.isArray(r["show"]) || r["show"].length > 6)
        return bad("it may show up to 6 fields.");
      for (const c of r["show"] as unknown[]) {
        const x = (c !== null && typeof c === "object" ? c : {}) as Record<string, unknown>;
        const l = text(x["label"], 60);
        if (typeof x["field"] !== "string" || !FIELD_PATH.test(x["field"]) || l === null)
          return bad("a field to show needs a field name and a label of at most 60 characters.");
        if (x["format"] !== undefined && x["format"] !== "text" && x["format"] !== "datetime")
          return bad('a field\'s format must be "text" or "datetime".');
        show.push({
          field: x["field"],
          label: l,
          ...(x["format"] ? { format: x["format"] as "text" | "datetime" } : {}),
        });
      }
    }
    out.push({
      id,
      label,
      source: r["source"],
      match: match as string[],
      show: show.length > 0 ? show : [{ field: "$updatedAt", label: "Saved", format: "datetime" }],
    });
  }
  return out;
}
