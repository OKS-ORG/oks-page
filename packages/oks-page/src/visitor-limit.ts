// A small limit for addresses that anyone may use: at most `max` uses of one key in `windowMs` (counted in memory only, so a
// restart starts the count again). The oldest keys are dropped when there are many.
const seen = new Map<string, number[]>();

/** True when this key has used its turns up; otherwise the use is counted. */
export function tooOften(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const recent = (seen.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    seen.set(key, recent);
    return true;
  }
  recent.push(now);
  seen.set(key, recent);
  if (seen.size > 5000)
    for (const [k, v] of seen) if (v.every((t) => now - t >= windowMs)) seen.delete(k);
  return false;
}
