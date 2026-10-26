// Direction-control characters can make stored text display differently from how it is stored
// (an override can make "invoice...gpj.exe" display as "invoiceexe.jpg"). Spec 03, section 4;
// spec 12, section 8 (D79).

const EMBEDDING_OR_OVERRIDE_MIN = 0x202a; // U+202A
const EMBEDDING_OR_OVERRIDE_MAX = 0x202e; // U+202E
const ISOLATE_MIN = 0x2066; // U+2066
const ISOLATE_MAX = 0x2068; // U+2068
const POP_ISOLATE = 0x2069; // U+2069

/** Removes U+202A-U+202E always, and any isolate (U+2066-U+2068) that is never closed by a
 * matching U+2069; a U+2069 with nothing open is removed too. U+200E, U+200F, U+200C and
 * U+200D are always kept. */
export function stripDirectionControls(text: string): string {
  const chars = Array.from(text);
  const keep = new Array<boolean>(chars.length).fill(true);
  const openIsolates: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0)!;
    if (cp >= EMBEDDING_OR_OVERRIDE_MIN && cp <= EMBEDDING_OR_OVERRIDE_MAX) {
      keep[i] = false;
    } else if (cp >= ISOLATE_MIN && cp <= ISOLATE_MAX) {
      openIsolates.push(i);
    } else if (cp === POP_ISOLATE) {
      if (openIsolates.length > 0) openIsolates.pop();
      else keep[i] = false;
    }
  }
  for (const i of openIsolates) keep[i] = false;
  if (keep.every(Boolean)) return text;
  return chars.filter((_, i) => keep[i]).join("");
}
