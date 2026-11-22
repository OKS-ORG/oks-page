// The form block (spec 16, section 3): a form a visitor fills in and sends to one of a plugin's own addresses. Only a
// plugin's block returns it. Everything about it is read here, once, for the block checks and for the HTML writer, so
// both agree: the form may only post to `/api/oks/plugins/<plugin>/<route>` of this site, every field has a name and a
// kind from a short list, and nothing is kept that is not text of a sensible length.
import { isSafeUrl } from "./schemes.js";

export const FORM_FIELD_TYPES = [
  "text",
  "email",
  "tel",
  "textarea",
  "number",
  "date",
  "select",
  "radio",
  "checkbox",
  "consent",
  "hidden",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  /** The name sent with the form: lower-case letters, digits and underscores, starting with a letter. */
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  help: string;
  placeholder: string;
  /** For a drop-down, round buttons or tick boxes. */
  options: string[];
  /** A hidden field's value. */
  value: string;
}

export interface FormProps {
  action: string;
  title: string;
  submit: string;
  /** A line under the fields, for example the privacy notice. */
  note: string;
  noteHref: string;
  /** What the plugin wants back with the form (a signed time, for its spam check). */
  token: string;
  formId: string;
  fields: FormField[];
}

export const FORM_ACTION = /^\/api\/oks\/plugins\/[a-z0-9-]{3,40}\/[a-z0-9-]{1,40}$/;
export const MOST_FORM_FIELDS = 30;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const TOKEN = /^[A-Za-z0-9._~-]{0,300}$/;
const FORM_ID = /^[a-z0-9-]{0,60}$/;

const text = (value: unknown, max: number): string => {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, max);
};

/**
 * The form a block's props describe, cleaned, or null when there is nothing safe to draw (no allowed action, or no
 * field left). A field with a name of its own, a kind not in the list or no label (unless hidden) is dropped.
 */
export function readForm(raw: Record<string, unknown>): FormProps | null {
  const action = typeof raw["action"] === "string" ? raw["action"] : "";
  if (!FORM_ACTION.test(action)) return null;
  const fields: FormField[] = [];
  const names = new Set<string>();
  for (const item of Array.isArray(raw["fields"]) ? raw["fields"] : []) {
    if (fields.length >= MOST_FORM_FIELDS) break;
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const f = item as Record<string, unknown>;
    const name = typeof f["name"] === "string" ? f["name"] : "";
    const type = f["type"] as FormFieldType;
    if (!FIELD_NAME.test(name) || names.has(name) || !FORM_FIELD_TYPES.includes(type)) continue;
    const label = text(f["label"], 200);
    if (type !== "hidden" && label === "") continue;
    const options = (Array.isArray(f["options"]) ? f["options"] : [])
      .map((o) => text(o, 100).trim())
      .filter((o) => o !== "")
      .slice(0, 30);
    if ((type === "select" || type === "radio" || type === "checkbox") && options.length === 0)
      continue;
    names.add(name);
    fields.push({
      name,
      label,
      type,
      required: f["required"] === true,
      help: text(f["help"], 300),
      placeholder: text(f["placeholder"], 100),
      options,
      value: text(f["value"], 200),
    });
  }
  if (fields.length === 0) return null;
  const token = typeof raw["token"] === "string" && TOKEN.test(raw["token"]) ? raw["token"] : "";
  const formId =
    typeof raw["formId"] === "string" && FORM_ID.test(raw["formId"]) ? raw["formId"] : "";
  const noteHref =
    typeof raw["noteHref"] === "string" && isSafeUrl(raw["noteHref"]) ? raw["noteHref"].trim() : "";
  return {
    action,
    title: text(raw["title"], 200),
    submit: text(raw["submit"], 60).trim() || "Send",
    note: text(raw["note"], 300),
    noteHref,
    token,
    formId,
    fields,
  };
}

/** The keys of a form block's props that `readForm` owns. */
export const FORM_KEYS = [
  "action",
  "title",
  "submit",
  "note",
  "noteHref",
  "token",
  "formId",
  "fields",
];
