// The CSS checker (spec 05, section 8). CSS from an owner or a theme author is data that we check, never code that we trust:
// it is read piece by piece, anything that could load something from outside, run script or break out of the style tag
// is refused, and what is kept is the text without its comments. Pure; no database.

export const CUSTOM_CSS_MAX_BYTES = 50 * 1024;
export const THEME_CSS_MAX_BYTES = 300 * 1024;
/** A small image written into the CSS itself may be at most about 20 KB (27,000 base64 characters). */
const DATA_IMAGE_MAX_CHARS = 27_000;

export interface CssCheckOptions {
  /** The most bytes the CSS may have. */
  maxBytes?: number;
  /** Whether `@font-face` is allowed (it needs files, so only for a theme package). */
  allowFontFace?: boolean;
  /** Whether `url()` may point to a relative file inside the theme (only for a theme package). */
  themeFiles?: boolean;
}

export interface CssProblem {
  line: number;
  message: string;
}

export type CssCheck =
  | {
      ok: true;
      css: string;
      /** The files inside the theme that `url()` points to. */ files: string[];
    }
  | { ok: false; errors: CssProblem[] };

const ALLOWED_AT = new Set([
  "media",
  "supports",
  "layer",
  "container",
  "keyframes",
  "-webkit-keyframes",
]);
const BREAKERS = /<\/style|<script|<!--/i;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]*=*$/i;
const RELATIVE_FILE = /^[A-Za-z0-9_\-./ ]+$/;
/** The place of the first control character that is not a tab, a line break or a form feed, or -1. */
const controlAt = (text: string): number => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return i;
  }
  return -1;
};
const lineOf = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/** Checks CSS and returns it without its comments, or the problems with the line of each. */
export function checkThemeCss(source: string, options: CssCheckOptions = {}): CssCheck {
  const errors: CssProblem[] = [];
  const files: string[] = [];
  const problem = (line: number, message: string) => {
    if (errors.length < 20) errors.push({ line, message });
  };
  if (typeof source !== "string")
    return { ok: false, errors: [{ line: 1, message: "The CSS was not text." }] };
  const maxBytes = options.maxBytes ?? CUSTOM_CSS_MAX_BYTES;
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > maxBytes)
    return {
      ok: false,
      errors: [
        {
          line: 1,
          message: `The CSS is ${Math.ceil(bytes / 1024)} KB; the most allowed is ${Math.floor(maxBytes / 1024)} KB.`,
        },
      ],
    };
  const control = controlAt(source);
  if (control >= 0)
    problem(lineOf(source, control), "The CSS has a control character that is not allowed.");
  const breaker = BREAKERS.exec(source);
  if (breaker) problem(lineOf(source, breaker.index), `"${breaker[0]}" is not allowed in CSS.`);

  // Read the text once. `kept` is the CSS without comments; `code` is the same with every string emptied, so the checks
  // below look only at what is really CSS and never at the text of a string.
  let kept = "";
  let code = "";
  let line = 1;
  const stack: { char: string; line: number }[] = [];
  const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) {
        problem(line, "A comment is never closed.");
        break;
      }
      const comment = source.slice(i, end + 2);
      line += comment.split("\n").length - 1;
      kept += " ";
      code += " ";
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        const c = source[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === ch) {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        problem(line, "A text in quotes is never closed.");
        break;
      }
      kept += source.slice(i, j + 1);
      code += `${ch}${ch}`;
      i = j + 1;
      continue;
    }
    if (ch === "\\") {
      problem(line, "A backslash outside a text in quotes is not allowed.");
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") stack.push({ char: ch, line });
    else if (ch === ")" || ch === "]" || ch === "}") {
      const open = stack.pop();
      if (!open || open.char !== closers[ch]) {
        problem(line, `"${ch}" does not match anything that was opened.`);
        break;
      }
    }
    if (ch === "\n") line++;
    // url( ... ): the address is read and judged here.
    if (ch === "(" && /url$/i.test(code)) {
      const start = i + 1;
      let j = start;
      while (j < source.length && /\s/.test(source[j]!)) j++;
      let address: string;
      let end: number;
      if (source[j] === '"' || source[j] === "'") {
        const quote = source[j]!;
        const close = source.indexOf(quote, j + 1);
        if (close < 0) {
          problem(line, "A text in quotes is never closed.");
          break;
        }
        address = source.slice(j + 1, close);
        end = close + 1;
      } else {
        const close = source.indexOf(")", j);
        if (close < 0) {
          problem(line, "A url( is never closed.");
          break;
        }
        address = source.slice(j, close).trim();
        end = close;
      }
      while (end < source.length && /\s/.test(source[end]!)) end++;
      if (source[end] !== ")") problem(line, "A url( has more than an address in it.");
      else if (/[\\\n\r"'()]/.test(address))
        problem(line, "This address has characters that are not allowed.");
      else if (DATA_IMAGE.test(address)) {
        if (address.length > DATA_IMAGE_MAX_CHARS)
          problem(line, "An image written into the CSS can be at most 20 KB.");
      } else if (
        options.themeFiles &&
        RELATIVE_FILE.test(address) &&
        !address.startsWith("/") &&
        !address.includes("..") &&
        !address.includes("//")
      ) {
        files.push(address);
      } else {
        problem(
          line,
          options.themeFiles
            ? "An address in url() must be a file inside the theme, or a small PNG, JPEG, GIF, WebP or AVIF image."
            : "url() may only hold a small PNG, JPEG, GIF, WebP or AVIF image written into the CSS.",
        );
      }
    }
    kept += ch;
    code += ch;
    i++;
  }
  if (stack.length > 0 && errors.length === 0)
    problem(stack[stack.length - 1]!.line, `"${stack[stack.length - 1]!.char}" is never closed.`);

  // At-rules: only a short list is allowed.
  const lower = code.toLowerCase();
  for (const match of lower.matchAll(/@([\w-]*)/g)) {
    const name = match[1]!;
    const allowed =
      ALLOWED_AT.has(name) || (name === "font-face" && options.allowFontFace === true);
    if (!allowed)
      problem(
        lineOf(code, match.index!),
        name ? `"@${name}" is not allowed here.` : 'A lone "@" is not allowed.',
      );
  }
  // Things that load from outside, run script or only exist to attack.
  const bad: [RegExp, string][] = [
    [/image-set\s*\(/, '"image-set()" is not allowed.'],
    [/(?:^|[^\w-])src\s*\(/, '"src()" is not allowed.'],
    [/expression\s*\(/, '"expression()" is not allowed.'],
    [/behavior\s*:/, '"behavior" is not allowed.'],
    [/-moz-binding/, '"-moz-binding" is not allowed.'],
    [/javascript\s*:/, '"javascript:" is not allowed.'],
    [/vbscript\s*:/, '"vbscript:" is not allowed.'],
  ];
  for (const [pattern, message] of bad) {
    const hit = pattern.exec(lower);
    if (hit) problem(lineOf(code, hit.index), message);
  }

  if (errors.length > 0) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  return { ok: true, css: kept.trim(), files };
}

/** The problems as plain sentences, for a message. */
export const describeCssProblems = (errors: CssProblem[]): string =>
  errors
    .slice(0, 5)
    .map((e) => `Line ${e.line}: ${e.message}`)
    .join(" ") + (errors.length > 5 ? ` (and ${errors.length - 5} more)` : "");
