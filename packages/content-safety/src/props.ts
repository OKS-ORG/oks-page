// Whether a block's `props` is safe to keep, as-is (spec 03, section 3 and 4).
import { byteLength } from "./bytes.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_PROPS_DEPTH = 6;
const MAX_PROPS_BYTES = 64 * 1024;

function isPlainJsonSafe(value: unknown, depth: number): boolean {
  if (depth > MAX_PROPS_DEPTH) return false;
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (t === "function" || t === "symbol" || t === "bigint" || t === "undefined") return false;
  if (Array.isArray(value)) return value.every((v) => isPlainJsonSafe(v, depth + 1));
  if (t === "object") {
    // An object literal such as { __proto__: {...} } sets the real prototype instead of
    // creating an own "__proto__" key, so Object.keys below would miss it; this catches that.
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) return false;
      if (!isPlainJsonSafe((value as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  }
  return false;
}

/** Missing becomes `{}`. Not plain JSON, over 6 levels deep, a forbidden key anywhere, or over
 * 64 KB: the whole thing becomes `{}` (one block's bad prop never corrupts the rest). Returns
 * `null` when nothing needed to change, so the caller can tell whether to report a repair. */
export function sanitizeProps(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  if (!isPlainJsonSafe(raw, 1)) return {};
  if (byteLength(JSON.stringify(raw)) > MAX_PROPS_BYTES) return {};
  return null;
}
