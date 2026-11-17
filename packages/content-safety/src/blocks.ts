// Checking one block and its children (spec 03, sections 3 and 4).
import { randomUUID } from "node:crypto";
import { checkContent, type Repairs } from "./content.js";
import { sanitizeProps } from "./props.js";
import { isSafeUrl, isSafeVideoUrl, isSafeColor, looksLikeScriptUrl } from "./schemes.js";

export interface Block {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content: unknown;
  children: Block[];
}

export const MAX_CHILDREN_DEPTH = 12;
export const MAX_BLOCKS = 5000;
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

const TYPE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const BUILT_IN_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "numberedList",
  "taskList",
  "quote",
  "callout",
  "toggle",
  "codeBlock",
  "divider",
  "image",
  "video",
  "embed",
  "table",
  "file",
  "bookmark",
  "columns",
]);

// The one URL-bearing prop for each built-in block type that has one. Video is checked
// separately (https, allowed hosts only).
const URL_PROP_BY_TYPE: Record<string, string> = {
  image: "src",
  file: "src",
  embed: "url",
  bookmark: "url",
};

function newBlockId(seenIds: Set<string>): string {
  let id = randomUUID().replace(/-/g, "").slice(0, 26);
  while (seenIds.has(id)) id = randomUUID().replace(/-/g, "").slice(0, 26);
  seenIds.add(id);
  return id;
}

function stripScriptLikeStrings(value: unknown, repairs: Repairs): unknown {
  if (looksLikeScriptUrl(value)) {
    repairs.add("stripped_script_url");
    return "";
  }
  if (Array.isArray(value)) return value.map((v) => stripScriptLikeStrings(v, repairs));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = stripScriptLikeStrings(v, repairs);
    return out;
  }
  return value;
}

function checkOneUrlProp(
  props: Record<string, unknown>,
  key: string,
  isSafe: (v: unknown) => boolean,
  repairs: Repairs,
): void {
  if (key in props && !isSafe(props[key])) {
    delete props[key];
    repairs.add("removed_url");
  }
}

function checkKnownTypeProps(type: string, props: Record<string, unknown>, repairs: Repairs): void {
  if ("href" in props && !isSafeUrl(props.href)) {
    delete props.href;
    repairs.add("removed_link");
  }
  if ("color" in props && !isSafeColor(props.color)) {
    delete props.color;
    repairs.add("removed_color");
  }
  if ("backgroundColor" in props && !isSafeColor(props.backgroundColor)) {
    delete props.backgroundColor;
    repairs.add("removed_color");
  }
  if (type === "video") {
    checkOneUrlProp(props, "src", isSafeVideoUrl, repairs);
  } else {
    const urlProp = URL_PROP_BY_TYPE[type];
    if (urlProp) checkOneUrlProp(props, urlProp, isSafeUrl, repairs);
  }
}

export interface Budget {
  remaining: number;
}

/** Checks one list of raw, untrusted block candidates and returns the safe blocks. `depth` is
 * the nesting level of this list (1 for the document's top-level blocks). `budget` is shared
 * across the whole document, so the 5,000-block cap (EC-21) applies to the document as a whole,
 * not to each list of children on its own. */
export function checkBlockList(
  raw: unknown,
  depth: number,
  seenIds: Set<string>,
  budget: Budget,
  repairs: Repairs,
): Block[] {
  if (!Array.isArray(raw)) return [];
  if (depth > MAX_CHILDREN_DEPTH) {
    if (raw.length > 0) repairs.add("cut_depth");
    return [];
  }
  const result: Block[] = [];
  for (const candidate of raw) {
    if (budget.remaining <= 0) {
      repairs.add("cut_block_count");
      break;
    }
    const block = checkOneBlock(candidate, depth, seenIds, budget, repairs);
    if (block) result.push(block);
  }
  return result;
}

function checkOneBlock(
  candidate: unknown,
  depth: number,
  seenIds: Set<string>,
  budget: Budget,
  repairs: Repairs,
): Block | null {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    repairs.add("removed_invalid_block");
    return null;
  }
  const raw = candidate as Record<string, unknown>;
  // The editor's own names have capital letters (bulletList, numberedList, taskList, codeBlock); a block of a plug-in
  // is lower case. Both are allowed; anything else is not a block.
  if (typeof raw.type !== "string" || !(BUILT_IN_TYPES.has(raw.type) || TYPE_RE.test(raw.type))) {
    repairs.add("removed_invalid_block");
    return null;
  }
  const type = raw.type;

  let missingField = false;
  let id: string;
  if (typeof raw.id === "string" && ID_RE.test(raw.id) && !seenIds.has(raw.id)) {
    id = raw.id;
    seenIds.add(id);
  } else if (raw.id === undefined) {
    id = newBlockId(seenIds);
    missingField = true;
  } else {
    id = newBlockId(seenIds);
    repairs.add("made_id_unique");
  }

  const sanitized = sanitizeProps(raw.props);
  if (raw.props === undefined) missingField = true;
  else if (sanitized !== null) repairs.add("cleared_props");
  const props = sanitized ?? (raw.props as Record<string, unknown>);
  if (BUILT_IN_TYPES.has(type)) {
    checkKnownTypeProps(type, props, repairs);
  } else {
    for (const key of Object.keys(props)) props[key] = stripScriptLikeStrings(props[key], repairs);
  }

  const content = checkContent(raw.content, repairs);

  let childrenRaw = raw.children;
  if (childrenRaw === undefined) {
    childrenRaw = [];
    missingField = true;
  } else if (!Array.isArray(childrenRaw)) {
    childrenRaw = [];
    missingField = true;
  }
  budget.remaining--;
  const children = checkBlockList(childrenRaw, depth + 1, seenIds, budget, repairs);

  if (missingField) repairs.add("filled_missing_fields");

  return { id, type, props, content, children };
}
