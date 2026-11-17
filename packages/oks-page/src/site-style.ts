// The owner's colors, fonts and custom CSS as a file (spec 05, TH-49): the page links to `/site-style/<fingerprint>.css`
// instead of carrying the text inline, so the browser keeps it, and a strict content security policy can later forbid
// inline styles. The name carries the first 16 letters of the text's SHA-256, so a name never changes its content.
import { createHash } from "node:crypto";

export const styleFileName = (css: string): string =>
  `${createHash("sha256").update(css).digest("hex").slice(0, 16)}.css`;
export const styleFileUrl = (css: string): string => `/site-style/${styleFileName(css)}`;
