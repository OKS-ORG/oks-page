// The inline items inside a block's `content`: text, link and mention (spec 03, section 3).
import { stripDirectionControls } from "./direction.js";
import { isSafeColor, isSafeUrl } from "./schemes.js";

const MAX_TEXT_LENGTH = 100_000;
// The only style keys a text run may carry; anything else is dropped.
const ALLOWED_TEXT_STYLE_KEYS = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "superscript",
  "subscript",
  "code",
  "color",
  "backgroundColor",
]);

export interface Repairs {
  add(kind: string): void;
}

function cleanText(raw: string, repairs: Repairs): string {
  let text = raw;
  const stripped = stripDirectionControls(text);
  if (stripped !== text) {
    repairs.add("stripped_direction_controls");
    text = stripped;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    repairs.add("truncated_text");
    text = text.slice(0, MAX_TEXT_LENGTH);
  }
  return text;
}

function cleanTextStyles(raw: unknown, repairs: Repairs): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    repairs.add("removed_style");
    return undefined;
  }
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_TEXT_STYLE_KEYS.has(key)) {
      changed = true;
      continue;
    }
    if (key === "color" || key === "backgroundColor") {
      if (isSafeColor(value)) out[key] = value;
      else {
        changed = true;
        repairs.add("removed_color");
      }
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else {
      changed = true;
    }
  }
  if (changed) repairs.add("removed_style");
  return out;
}

/** An unsafe link becomes plain text: its wrapper is dropped and its own text content, if any,
 * is kept (spec 03, section 4: "an unsafe link becomes plain text"). */
export function checkContent(raw: unknown, repairs: Repairs): unknown {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return raw; // a table or another shape: left to its own checks later
  const out: unknown[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (obj.type === "text") {
      const text = typeof obj.text === "string" ? obj.text : "";
      const styles = cleanTextStyles(obj.styles, repairs);
      const next: Record<string, unknown> = { type: "text", text: cleanText(text, repairs) };
      if (styles && Object.keys(styles).length > 0) next.styles = styles;
      out.push(next);
    } else if (obj.type === "link") {
      if (isSafeUrl(obj.href)) {
        out.push({ ...obj, href: obj.href });
      } else {
        repairs.add("removed_link");
        const inner = Array.isArray(obj.content) ? obj.content : [];
        for (const innerItem of inner) out.push(innerItem);
      }
    } else if (obj.type === "mention") {
      if (typeof obj.id === "string") out.push({ type: "mention", id: obj.id });
      else repairs.add("removed_invalid_block");
    }
    // Any other inline type is dropped: it is not one of the three the spec defines.
  }
  return out;
}
