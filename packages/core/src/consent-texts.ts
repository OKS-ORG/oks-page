// The words of the consent notice (spec 18, section 2: "Its texts can be changed"). The owner may change the heading, the
// introduction and the button labels; the fixed rules stay fixed in code: Accept all and Refuse all always both exist,
// look the same and weigh the same, and nothing is pre-ticked. Plain text only (the page shows it as text, never as HTML).
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";

export const CONSENT_TEXTS_KEY = "consent_texts";

export type ConsentTextId = "title" | "intro" | "accept" | "refuse" | "save" | "reopen";

export interface ConsentTextField {
  id: ConsentTextId;
  label: string;
  /** What the visitor sees unless the owner changes it. */
  default: string;
  max: number;
  /** True for a longer text (shown in a larger box). */
  long?: boolean;
}

export const CONSENT_TEXT_FIELDS: ConsentTextField[] = [
  { id: "title", label: "Heading", default: "Your privacy choices", max: 60 },
  {
    id: "intro",
    label: "Introduction",
    default:
      "This site would like to use the following. Nothing in this list is used unless you agree, and you can change your mind at any time with the “Privacy choices” button.",
    max: 400,
    long: true,
  },
  { id: "accept", label: "Button: accept everything", default: "Accept all", max: 30 },
  { id: "refuse", label: "Button: refuse everything", default: "Refuse all", max: 30 },
  { id: "save", label: "Button: save the choices made", default: "Save my choices", max: 30 },
  { id: "reopen", label: "Button: change the choice later", default: "Privacy choices", max: 30 },
];

export type ConsentTexts = Record<ConsentTextId, string>;

export const DEFAULT_CONSENT_TEXTS = Object.fromEntries(
  CONSENT_TEXT_FIELDS.map((f) => [f.id, f.default]),
) as ConsentTexts;

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** A clean text: no control characters, spaces tidied. Empty when it is nothing. */
const tidy = (v: string): string =>
  Array.from(v, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/** The texts in force: the owner's where sound, else the default of each. */
export function effectiveTexts(stored: unknown): ConsentTexts {
  const chosen =
    stored !== null && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const out = { ...DEFAULT_CONSENT_TEXTS };
  for (const f of CONSENT_TEXT_FIELDS) {
    const v = chosen[f.id];
    if (typeof v !== "string") continue;
    const t = tidy(v);
    if (t.length > 0 && t.length <= f.max) out[f.id] = t;
  }
  return out;
}

export async function loadConsentTexts(runner: SqlRunner, siteId: string): Promise<ConsentTexts> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, CONSENT_TEXTS_KEY],
  );
  return effectiveTexts(decode(runner, rows[0]?.["value"]));
}

/**
 * Saves the owner's texts. A text that is left empty goes back to its default; one that is too long is refused. Only people
 * who manage the settings.
 */
export async function saveConsentTexts(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: unknown,
): Promise<{ ok: true; texts: ConsentTexts } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { ok: false, code: "invalid", message: "The request was not understood." };
  const given = input as Record<string, unknown>;
  const unknown = Object.keys(given).find((k) => !CONSENT_TEXT_FIELDS.some((f) => f.id === k));
  if (unknown)
    return {
      ok: false,
      code: "invalid",
      message: "This is not a text of the consent notice.",
      field: unknown,
    };
  const out: Partial<ConsentTexts> = {};
  for (const f of CONSENT_TEXT_FIELDS) {
    const v = given[f.id];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string")
      return { ok: false, code: "invalid", message: `${f.label}: write some words.`, field: f.id };
    const t = tidy(v);
    if (t.length > f.max)
      return {
        ok: false,
        code: "invalid",
        message: `${f.label}: use at most ${f.max} characters.`,
        field: f.id,
      };
    // Empty, or the same as the default, means the default.
    if (t.length > 0 && t !== f.default) out[f.id] = t;
  }
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, CONSENT_TEXTS_KEY, JSON.stringify(out), new Date()],
  );
  return { ok: true, texts: effectiveTexts(out) };
}
