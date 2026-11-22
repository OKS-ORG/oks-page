// The block checks: every save, import, API call and plugin write passes the same checks, in
// the core, before anything reaches the database. They repair what they can and report what
// they changed (spec 03, section 4; ADR 0019).
import { byteLength } from "./bytes.js";
import {
  type Block,
  type Budget,
  checkBlockList,
  MAX_BLOCKS,
  MAX_DOCUMENT_BYTES,
} from "./blocks.js";

export type { Block };
export { convertOldStyles } from "./blocks.js";
export {
  FORM_ACTION,
  FORM_FIELD_TYPES,
  readForm,
  type FormField,
  type FormFieldType,
  type FormProps,
} from "./form.js";
export { effectiveStyle, positionWarnings } from "./position.js";
export {
  BREAKPOINTS,
  DEFAULT_BREAKPOINTS,
  breakpointRanges,
  SCREEN_LABELS,
  screenSizesOf,
  type ScreenSize,
  checkStyle,
  convertPhysicalStyle,
  generateCss,
  styleClass,
  styleKey,
  STYLE_PROPERTIES,
  type BreakpointName,
  type BreakpointRange,
  type CheckedStyle,
  type Style,
} from "./styles.js";
export {
  applyOp,
  countBlocks,
  duplicateBlock,
  duplicateInPlace,
  insertBlock,
  moveBlock,
  placementProblem,
  removeBlock,
  updateProps,
  type TreeOp,
  type TreeResult,
} from "./tree.js";

export interface CheckedBody {
  version: number;
  blocks: Block[];
}

export interface CheckBlocksResult {
  body: CheckedBody;
  /** One entry per repair made, so a caller can show "we fixed N things" without guessing. */
  repairs: string[];
}

function limitDocumentSize(body: CheckedBody, repairs: string[]): CheckedBody {
  if (byteLength(JSON.stringify(body)) <= MAX_DOCUMENT_BYTES) return body;
  const blocks = body.blocks.slice();
  while (blocks.length > 0) {
    blocks.pop();
    const next = { version: body.version, blocks };
    if (byteLength(JSON.stringify(next)) <= MAX_DOCUMENT_BYTES) {
      repairs.push("cut_document_size");
      return next;
    }
  }
  repairs.push("cut_document_size");
  return { version: body.version, blocks: [] };
}

/** Checks a whole stored body (`{ version, blocks }`), as read from the database, an import,
 * the content API or a plugin write. Never throws: anything it cannot make sense of becomes an
 * empty, safe body instead. */
export function checkBlocks(
  input: unknown,
  options: { breakpoints?: readonly string[] } = {},
): CheckBlocksResult {
  const repairs: string[] = [];
  let version = 1;
  let rawBlocks: unknown;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (typeof obj.version === "number" && Number.isInteger(obj.version)) version = obj.version;
    rawBlocks = obj.blocks;
  } else {
    rawBlocks = input; // a bare array is tolerated, so callers do not have to wrap it first
  }

  if (!Array.isArray(rawBlocks)) {
    repairs.push("not_a_list");
    return { body: { version, blocks: [] }, repairs };
  }

  const seenIds = new Set<string>();
  const budget: Budget = { remaining: MAX_BLOCKS, breakpoints: options.breakpoints };
  const blocks = checkBlockList(rawBlocks, 1, seenIds, budget, { add: (k) => repairs.push(k) });
  const body = limitDocumentSize({ version, blocks }, repairs);
  return { body, repairs };
}
export { isSafeColor, isSafeUrl, isSafeVideoUrl } from "./schemes.js";
export { hasLock, LOCKED_MESSAGE, lockViolation } from "./locks.js";
export {
  flattenForWriting,
  LAYOUT_ONLY,
  wrapForLayout,
  type FlattenResult,
} from "./editor-switch.js";
