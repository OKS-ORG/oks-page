// Help with the imprint and the accessibility statement (spec 18, section 4). Like the privacy page draft, each makes a draft
// page from what the owner tells the site and what the site knows; nothing is published, and the owner reads and changes it.
// The site never says more than it knows: the accessibility draft does not claim that the site complies with anything.
import type { SqlRunner } from "@oks-page/db";
import { createDraft, saveContent, type Actor } from "./content.js";

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

const text = (t: string) => ({ type: "text", text: t });
const paragraph = (id: string, t: string) => ({
  id,
  type: "paragraph",
  props: {},
  content: [text(t)],
  children: [],
});
const heading = (id: string, t: string) => ({
  id,
  type: "heading",
  props: { level: 2 },
  content: [text(t)],
  children: [],
});

// ---------------------------------------------------------------------------------------------------------------- imprint

export interface ImprintInput {
  name: string;
  address: string;
  email: string;
  phone?: string;
  register?: string;
  vat?: string;
  responsible?: string;
}

const IMPRINT_FIELDS: { id: keyof ImprintInput; label: string; max: number; required: boolean }[] =
  [
    { id: "name", label: "Who runs the site", max: 120, required: true },
    { id: "address", label: "Address", max: 300, required: true },
    { id: "email", label: "Email address", max: 120, required: true },
    { id: "phone", label: "Phone number", max: 40, required: false },
    { id: "register", label: "Commercial register and number", max: 120, required: false },
    { id: "vat", label: "VAT number", max: 40, required: false },
    { id: "responsible", label: "Person responsible for the content", max: 120, required: false },
  ];

/** What the owner is asked for in the imprint form, for the screen. */
export const IMPRINT_FIELD_LIST = IMPRINT_FIELDS;

const tidy = (v: string): string =>
  Array.from(v, (c) => (c.charCodeAt(0) < 32 && c !== "\n" ? " " : c))
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

/** The imprint input, checked, or the words for what is wrong. */
export function readImprint(input: unknown): { ok: true; value: ImprintInput } | Fail {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { ok: false, code: "invalid", message: "The request was not understood." };
  const given = input as Record<string, unknown>;
  const unknown = Object.keys(given).find((k) => !IMPRINT_FIELDS.some((f) => f.id === k));
  if (unknown)
    return {
      ok: false,
      code: "invalid",
      message: "This is not part of an imprint.",
      field: unknown,
    };
  const out: Record<string, string> = {};
  for (const f of IMPRINT_FIELDS) {
    const raw = given[f.id];
    if (raw !== undefined && raw !== null && typeof raw !== "string")
      return { ok: false, code: "invalid", message: `${f.label}: write some words.`, field: f.id };
    const v = tidy(typeof raw === "string" ? raw : "");
    if (v === "") {
      if (f.required)
        return { ok: false, code: "invalid", message: `${f.label}: this is needed.`, field: f.id };
      continue;
    }
    if (v.length > f.max)
      return {
        ok: false,
        code: "invalid",
        message: `${f.label}: use at most ${f.max} characters.`,
        field: f.id,
      };
    out[f.id] = v;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out["email"]!))
    return {
      ok: false,
      code: "invalid",
      message: "Email address: write an address such as name@example.com.",
      field: "email",
    };
  return { ok: true, value: out as unknown as ImprintInput };
}

/** The blocks of an imprint draft: only what the owner gave, in the usual order. */
export function imprintDraftBlocks(i: ImprintInput): unknown[] {
  const blocks: unknown[] = [
    paragraph(
      "intro",
      "This is a draft written by the site from what you entered. Check it against the law of your country and add what it asks for: some countries ask for more (a supervisory authority, a professional title, a register number).",
    ),
    heading("who-h", "Who runs this site"),
    paragraph("who", i.name),
    ...i.address.split("\n").map((line, n) => paragraph(`address-${n}`, line)),
    heading("contact-h", "Contact"),
    paragraph("email", `Email: ${i.email}`),
  ];
  if (i.phone) blocks.push(paragraph("phone", `Phone: ${i.phone}`));
  if (i.register)
    blocks.push(heading("register-h", "Commercial register"), paragraph("register", i.register));
  if (i.vat) blocks.push(heading("vat-h", "VAT number"), paragraph("vat", i.vat));
  if (i.responsible)
    blocks.push(
      heading("responsible-h", "Responsible for the content"),
      paragraph("responsible", i.responsible),
    );
  return blocks;
}

/** Makes a draft page "Imprint" from what the owner entered. Nothing is published. Only people who manage the settings. */
export async function writeImprintDraft(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: unknown,
): Promise<{ ok: true; id: string; slug: string } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  const read = readImprint(input);
  if (!read.ok) return read;
  return writeDraftPage(runner, actor, siteId, "Imprint", imprintDraftBlocks(read.value));
}

// ----------------------------------------------------------------------------------------- accessibility statement

/** One kind of problem the checker found, with how often and on which pages. */
export interface AccessibilityFinding {
  /** In plain words ("Pictures without a description"). */
  label: string;
  count: number;
  /** Titles of some of the pages it is on (the first few). */
  pages: string[];
}

export interface AccessibilityFacts {
  siteName: string;
  /** Where visitors can report a problem. */
  contactEmail: string;
  /** The day of the check, as text ("24 November 2026"). */
  date: string;
  /** How many published pages and posts the checker read. */
  pagesChecked: number;
  findings: AccessibilityFinding[];
}

/** The blocks of an accessibility statement draft. It says what was checked and found, and claims nothing more. */
export function accessibilityStatementBlocks(f: AccessibilityFacts): unknown[] {
  const total = f.findings.reduce((n, x) => n + x.count, 0);
  const blocks: unknown[] = [
    paragraph(
      "intro",
      `This is a draft written by the site. It states what ${f.siteName} knows about its own accessibility and nothing more: read it, correct it, and have the site checked by a person before you say that it meets a standard.`,
    ),
    heading("goal-h", "Our aim"),
    paragraph(
      "goal",
      `${f.siteName} aims to be usable by everyone, including people who use a screen reader, a keyboard instead of a mouse, or a larger text size. We aim to meet the Web Content Accessibility Guidelines (WCAG) 2.1 at level AA, as the European Accessibility Act asks.`,
    ),
    heading("status-h", "Where we stand"),
    paragraph(
      "status",
      `On ${f.date} an automatic check read ${f.pagesChecked} published page${f.pagesChecked === 1 ? "" : "s"} and ${
        total === 0
          ? "found none of the problems it can detect."
          : `found ${total} problem${total === 1 ? "" : "s"} it can detect.`
      } An automatic check finds only some problems (for example a missing description of a picture, a skipped heading level, or text that is hard to read against its background). It cannot judge everything, so we do not claim that the site fully meets WCAG 2.1 AA.`,
    ),
  ];
  if (f.findings.length > 0) {
    blocks.push(heading("known-h", "Known problems"));
    for (const [n, x] of f.findings.entries())
      blocks.push(
        paragraph(
          `known-${n}`,
          `${x.label}: ${x.count} time${x.count === 1 ? "" : "s"}${
            x.pages.length > 0 ? `, for example on ${x.pages.join(", ")}` : ""
          }. We are working on it.`,
        ),
      );
  }
  blocks.push(
    heading("contact-h", "Tell us about a problem"),
    paragraph(
      "contact",
      `If something on this site is hard to use, write to ${f.contactEmail}. Tell us the address of the page and what went wrong, and we will answer and try to fix it. If you are not satisfied with our answer, you may contact the supervisory body for accessibility in your country.`,
    ),
    paragraph("updated", `This statement was last updated on ${f.date}.`),
  );
  return blocks;
}

/** Makes a draft page "Accessibility statement" from facts the site worked out. Nothing is published. */
export async function writeAccessibilityStatementDraft(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  facts: AccessibilityFacts,
): Promise<{ ok: true; id: string; slug: string } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(facts.contactEmail) || facts.contactEmail.length > 120)
    return {
      ok: false,
      code: "invalid",
      message: "Contact email: write an address such as name@example.com.",
      field: "contactEmail",
    };
  return writeDraftPage(
    runner,
    actor,
    siteId,
    "Accessibility statement",
    accessibilityStatementBlocks(facts),
  );
}

async function writeDraftPage(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  title: string,
  blocks: unknown[],
): Promise<{ ok: true; id: string; slug: string } | Fail> {
  const made = await createDraft(runner, actor, siteId, { type: "page", title });
  if (!made.ok)
    return {
      ok: false,
      code: made.code === "forbidden" ? "forbidden" : "invalid",
      message: made.message,
    };
  const saved = await saveContent(runner, actor, siteId, made.id, {
    title,
    slugPart: made.slug,
    status: "draft",
    blocks,
    revision: made.revision,
  });
  if (!saved.ok) return { ok: false, code: "invalid", message: saved.message };
  return { ok: true, id: made.id, slug: made.slug };
}
