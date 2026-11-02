// Redirects for an exported site (spec 10, section 6.1; ST-13 to ST-17). One list becomes three outputs, so it works on any
// host: `_redirects` (Netlify and Cloudflare Pages), `.htaccess` (Apache) and a small HTML page at the old address.
// A redirect is written into host files, where some characters mean "wildcard" or "new line", so unsafe ones are refused.

export interface Redirect {
  /** The old address, a path such as `/old-page`. */
  from: string;
  /** The new address: a path such as `/new-page/`, or a full http(s) address. */
  to: string;
  /** Default 301 (moved for good). */
  status?: 301 | 302 | 307 | 308;
}

export interface RefusedRedirect {
  redirect: Redirect;
  /** A plain sentence for the owner. */
  reason: string;
}

export interface RedirectFiles {
  /** The content of `_redirects`. */
  redirectsFile: string;
  /** The lines for `.htaccess`. */
  htaccess: string;
  /** One small HTML page for each redirect: `path` is the file to write, relative to the site folder. */
  pages: { path: string; html: string }[];
  refused: RefusedRedirect[];
}

// Spaces and control characters, and the characters that host files read as wildcards, placeholders or quotes.
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH = /[\s\u0000-\u001f\u007f*:!"'`\\<>^{}|#?()[\],;=@$&+~]/u;
// eslint-disable-next-line no-control-regex
const UNSAFE_TARGET = /[\s\u0000-\u001f\u007f"'`\\<>^{}|]/u;

/** Returns a plain sentence when the old address cannot be used, or null when it is safe. */
function checkFrom(from: string): string | null {
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//"))
    return "The old address must start with one slash, like /old-page.";
  if (UNSAFE_PATH.test(from))
    return "The old address has a space or a special character that a host file would read as a rule.";
  if (from.split("/").some((part) => part === ".."))
    return "The old address may not contain two dots between slashes.";
  return null;
}

/** Returns a plain sentence when the new address cannot be used, or null when it is safe. */
function checkTo(to: string): string | null {
  if (typeof to !== "string" || to.length === 0) return "The new address is empty.";
  if (UNSAFE_TARGET.test(to))
    return "The new address has a space, a quote or another unsafe character.";
  if (to.startsWith("/")) {
    if (to.startsWith("//"))
      return "The new address must be a path with one slash, or a full address that starts with http:// or https://.";
    return null;
  }
  let url: URL;
  try {
    url = new URL(to);
  } catch {
    return "The new address must be a path that starts with / or a full address that starts with http:// or https://.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "The new address may only be a path or an http:// or https:// address.";
  if (!url.hostname) return "The new address has no website name.";
  return null;
}

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The file to write for the page at an old address: a folder with index.html, unless the address already ends in a file name. */
function pageFile(from: string): string {
  const clean = from.replace(/\/+$/, "");
  const last = clean.split("/").pop() ?? "";
  if (last.includes(".")) return clean.slice(1);
  return `${clean.slice(1)}/index.html`;
}

function redirectPage(to: string): string {
  const safe = escapeHtml(to);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>This page has moved</title>",
    '<meta name="robots" content="noindex">',
    `<link rel="canonical" href="${safe}">`,
    `<meta http-equiv="refresh" content="0; url=${safe}">`,
    "</head>",
    `<body><p>This page has moved to <a href="${safe}">${safe}</a>.</p></body>`,
    "</html>",
    "",
  ].join("\n");
}

/** Checks one redirect. Returns a plain sentence when it must be refused, or null when it is safe. */
export function checkRedirect(redirect: Redirect): string | null {
  const bad = checkFrom(redirect.from) ?? checkTo(redirect.to);
  if (bad) return bad;
  if (redirect.from === redirect.to) return "The old and the new address are the same.";
  return null;
}

/** Turns a list of redirects into the three outputs. Unsafe or repeated redirects are left out and listed in `refused`. */
export function buildRedirectFiles(list: Redirect[]): RedirectFiles {
  const refused: RefusedRedirect[] = [];
  const seen = new Set<string>();
  const redirects: string[] = [];
  const htaccess: string[] = [];
  const pages: { path: string; html: string }[] = [];
  for (const redirect of list) {
    const reason = checkRedirect(redirect);
    if (reason) {
      refused.push({ redirect, reason });
      continue;
    }
    if (seen.has(redirect.from)) {
      refused.push({
        redirect,
        reason: "There are two redirects for the same old address; only the first is used.",
      });
      continue;
    }
    seen.add(redirect.from);
    const status = redirect.status ?? 301;
    redirects.push(`${redirect.from} ${redirect.to} ${status}`);
    htaccess.push(`Redirect ${status} "${redirect.from}" "${redirect.to}"`);
    pages.push({ path: pageFile(redirect.from), html: redirectPage(redirect.to) });
  }
  return {
    redirectsFile: redirects.length ? `${redirects.join("\n")}\n` : "",
    htaccess: htaccess.length ? `${htaccess.join("\n")}\n` : "",
    pages,
    refused,
  };
}
