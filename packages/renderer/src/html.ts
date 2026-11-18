// Our own HTML writer (spec 03, section 5): blocks become the HTML that is stored in `entries.html` (feeds, email, the
// content API) and the plain text that is stored in `entries.plain_text` (search, excerpts).
//
// Every text and every attribute value is escaped. Only addresses and colours that pass the same checks as the block
// checks are written, so the writer is safe even for blocks that did not go through the checks. oks-ui's own HTML
// function is never used (EC-32).
import { layoutCss } from "./block-css.js";
import { ICONS } from "./icons.js";
import {
  BREAKPOINTS,
  checkStyle,
  generateCss,
  isSafeColor,
  isSafeUrl,
  isSafeVideoUrl,
  styleClass,
  type Block,
  type Style,
} from "@oks-page/content-safety";

export interface Written {
  html: string;
  plainText: string;
  /** Block types the writer does not draw (a plugin's own block, for example). They are left out, never guessed at. */
  skipped: string[];
}

const MAX_DEPTH = 12;
const LIST_TYPES = new Set(["bulletList", "numberedList", "taskList"]);
const CALLOUTS = new Set(["info", "warning", "error", "success", "tip"]);
const SOCIAL: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  x: "X",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  github: "GitHub",
  mastodon: "Mastodon",
  email: "Email",
};
const SPACER_SIZES = new Set(["xs", "sm", "md", "lg", "xl"]);
const BUTTON_STYLES = new Set(["solid", "outline", "link"]);

// An anchor name is a short word: letters, digits, dash and underscore, starting with a letter.
const anchorAttribute = (p: Record<string, unknown>): string => {
  const anchor = typeof p["anchor"] === "string" ? p["anchor"] : "";
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(anchor) ? ` id="${anchor}"` : "";
};

export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const props = (block: Block): Record<string, unknown> => block.props ?? {};

// ---- inline content: text, links, mentions ----

interface Run {
  type?: unknown;
  text?: unknown;
  href?: unknown;
  styles?: Record<string, unknown>;
}

function runHtml(item: unknown): string {
  if (item === null || typeof item !== "object") return "";
  const run = item as Run;
  let html = escapeHtml(str(run.text)).replace(/\n/g, "<br>");
  const styles = run.styles && typeof run.styles === "object" ? run.styles : {};
  if (styles["code"] === true) html = `<code>${html}</code>`;
  if (styles["bold"] === true) html = `<strong>${html}</strong>`;
  if (styles["italic"] === true) html = `<em>${html}</em>`;
  if (styles["underline"] === true) html = `<u>${html}</u>`;
  if (styles["strikethrough"] === true) html = `<s>${html}</s>`;
  if (styles["superscript"] === true) html = `<sup>${html}</sup>`;
  if (styles["subscript"] === true) html = `<sub>${html}</sub>`;
  const css: string[] = [];
  if (isSafeColor(styles["color"])) css.push(`color:${String(styles["color"]).trim()}`);
  if (isSafeColor(styles["backgroundColor"]))
    css.push(`background-color:${String(styles["backgroundColor"]).trim()}`);
  if (css.length > 0) html = `<span style="${escapeHtml(css.join(";"))}">${html}</span>`;
  if (run.type === "link" && isSafeUrl(run.href))
    html = `<a href="${escapeHtml(str(run.href).trim())}" rel="noopener noreferrer">${html}</a>`;
  else if (run.type === "mention") html = `<span class="mention">${html}</span>`;
  return html;
}

const inline = (content: unknown): string =>
  Array.isArray(content) ? content.map(runHtml).join("") : "";

const inlineText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((item) => (item && typeof item === "object" ? str((item as Run).text) : ""))
        .join("")
    : "";

// ---- video: only a few hosts, drawn through their privacy-friendly player address ----

function videoPlayer(raw: string): string | null {
  if (!isSafeVideoUrl(raw)) return null;
  // eslint-disable-next-line no-control-regex -- the same control characters the address check strips (EC-07)
  const url = new URL(raw.replace(/[\u0000- ]+/g, ""));
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1);
    return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const id = url.pathname.startsWith("/embed/")
      ? url.pathname.slice(7)
      : (url.searchParams.get("v") ?? "");
    return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  const vimeo = /^\/(?:video\/)?(\d{4,12})$/.exec(url.pathname);
  return host.endsWith("vimeo.com") && vimeo ? `https://player.vimeo.com/video/${vimeo[1]}` : null;
}

const formatBytes = (size: number): string =>
  size >= 1_000_000
    ? `${(size / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1000))} KB`;

// ---- blocks ----

interface Context {
  depth: number;
  skipped: Set<string>;
  /** The layout editor asks for each block's id on its first element, so a click in the preview can find the block. */
  ids: boolean;
}

const alignStyle = (block: Block): string => {
  const align = props(block)["align"];
  return align === "center" || align === "end" ? ` style="text-align:${align}"` : "";
};

function tableHtml(block: Block): string {
  const content = block.content as { rows?: { cells?: unknown[] }[] } | null;
  const rows = Array.isArray(content?.rows) ? content.rows : [];
  const header = props(block)["headerRow"] === true;
  const row = (r: { cells?: unknown[] }, cell: "td" | "th") =>
    `<tr>${(Array.isArray(r.cells) ? r.cells : []).map((c) => `<${cell}${cell === "th" ? ' scope="col"' : ""}>${inline(c)}</${cell}>`).join("")}</tr>`;
  const head = header && rows[0] ? `<thead>${row(rows[0], "th")}</thead>` : "";
  const body = rows.slice(header ? 1 : 0).map((r) => row(r, "td"));
  return `<table>${head}<tbody>${body.join("")}</tbody></table>`;
}

function listHtml(items: Block[], ctx: Context): string {
  const type = items[0]!.type;
  const tag = type === "numberedList" ? "ol" : "ul";
  const li = items.map((item) => {
    const box =
      type === "taskList"
        ? `<input type="checkbox" disabled${props(item)["checked"] === true ? " checked" : ""}> `
        : "";
    return `<li>${box}${inline(item.content)}${blocksHtml(item.children, ctx)}</li>`;
  });
  return `<${tag}${type === "taskList" ? ' class="task-list"' : ""}>${li.join("")}</${tag}>`;
}

function blockHtml(block: Block, ctx: Context): string {
  const p = props(block);
  const children = blocksHtml(block.children, ctx);
  switch (block.type) {
    case "paragraph":
      return `<p${alignStyle(block)}>${inline(block.content)}</p>${children}`;
    case "heading": {
      const level = Math.min(Math.max(Math.trunc(Number(p["level"])) || 2, 1), 6);
      return `<h${level}${alignStyle(block)}>${inline(block.content)}</h${level}>${children}`;
    }
    case "quote":
      return `<blockquote${alignStyle(block)}><p>${inline(block.content)}</p>${children}</blockquote>`;
    case "callout": {
      const variant = CALLOUTS.has(str(p["variant"])) ? str(p["variant"]) : "info";
      return `<aside class="callout callout-${variant}"><p>${inline(block.content)}</p>${children}</aside>`;
    }
    case "toggle":
      return `<details><summary>${inline(block.content)}</summary>${children}</details>`;
    case "codeBlock": {
      const language = str(p["language"]).replace(/[^\w#+.-]/g, "") || "plaintext";
      return `<pre><code class="language-${language}">${escapeHtml(inlineText(block.content))}</code></pre>`;
    }
    case "divider":
      return "<hr>";
    case "image": {
      const src = str(p["src"]).trim();
      if (!isSafeUrl(src)) return "";
      // A picture marked as decoration has an empty description, so a screen reader skips it.
      const alt = p["decorative"] === true ? "" : str(p["alt"]);
      const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`;
      const caption = str(p["caption"]);
      return caption
        ? `<figure>${img}<figcaption>${escapeHtml(caption)}</figcaption></figure>`
        : `<figure>${img}</figure>`;
    }
    case "video": {
      const player = videoPlayer(str(p["src"]));
      if (!player) return "";
      const title = str(p["caption"]) || "Video";
      return `<iframe src="${escapeHtml(player)}" title="${escapeHtml(title)}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    }
    case "embed": {
      const url = str(p["url"]).trim();
      return isSafeUrl(url)
        ? `<p><a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(url)}</a></p>`
        : "";
    }
    case "file": {
      const url = str(p["url"]).trim();
      const name = str(p["name"]) || url;
      if (!name) return "";
      const size =
        Number(p["size"]) > 0
          ? ` <span class="file-size">${formatBytes(Number(p["size"]))}</span>`
          : "";
      return isSafeUrl(url)
        ? `<p><a href="${escapeHtml(url)}" download rel="noopener noreferrer">${escapeHtml(name)}</a>${size}</p>`
        : `<p>${escapeHtml(name)}${size}</p>`;
    }
    case "bookmark": {
      const url = str(p["url"]).trim();
      const title = str(p["title"]) || url;
      const description = str(p["description"]);
      const text = description ? `<p>${escapeHtml(description)}</p>` : "";
      if (!title) return "";
      return isSafeUrl(url)
        ? `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></p>${text}`
        : `<p>${escapeHtml(title)}</p>${text}`;
    }
    case "table":
      return tableHtml(block);
    case "columns":
      // A column of the layout editor draws itself; a block placed straight inside (a page of the writing editor) is wrapped.
      return `<div class="columns">${block.children.map((child) => (child.type === "column" ? blocksHtml([child], ctx) : `<div class="column">${blocksHtml([child], ctx)}</div>`)).join("")}</div>`;
    case "column":
      return `<div class="column">${children}</div>`;
    case "section": {
      const width = p["width"] === "full" ? "full" : "boxed";
      return `<section${anchorAttribute(p)} class="section section-${width}">${children}</section>`;
    }
    case "container":
      return `<div${anchorAttribute(p)} class="container">${children}</div>`;
    case "spacer": {
      const size = SPACER_SIZES.has(str(p["size"])) ? str(p["size"]) : "md";
      return `<div class="spacer spacer-${size}" aria-hidden="true"></div>`;
    }
    case "button": {
      const text = str(p["text"]).trim();
      if (!text) return "";
      const variant = BUTTON_STYLES.has(str(p["variant"])) ? str(p["variant"]) : "solid";
      const href = str(p["href"]).trim();
      const label = escapeHtml(text);
      return isSafeUrl(href)
        ? `<a class="button button-${variant}" href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`
        : `<span class="button button-${variant}">${label}</span>`;
    }
    case "buttonGroup":
      return `<div class="button-group">${children}</div>`;
    case "gallery": {
      const items = (Array.isArray(p["images"]) ? p["images"] : []).flatMap((raw: unknown) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        const src = str(item["src"]).trim();
        if (!isSafeUrl(src)) return [];
        const caption = str(item["caption"]);
        const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(str(item["alt"]))}" loading="lazy">`;
        return [
          `<li><figure>${img}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure></li>`,
        ];
      });
      if (items.length === 0) return "";
      const columns = Math.min(Math.max(Math.trunc(Number(p["columns"])) || 3, 1), 6);
      return `<ul class="gallery gallery-${columns}">${items.join("")}</ul>`;
    }
    case "audio": {
      const src = str(p["src"]).trim();
      if (!isSafeUrl(src)) return "";
      const title = str(p["title"]);
      const link = `<a href="${escapeHtml(src)}" rel="noopener noreferrer">${escapeHtml(title || "Play the audio")}</a>`;
      return `<figure class="audio">${title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ""}<audio controls preload="none" src="${escapeHtml(src)}">${link}</audio></figure>`;
    }
    case "icon": {
      const path = ICONS[str(p["name"])];
      if (!path) return "";
      const size = Math.min(Math.max(Math.trunc(Number(p["size"])) || 24, 8), 128);
      const label = str(p["label"]);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
      const href = str(p["href"]).trim();
      if (isSafeUrl(href))
        return `<a class="icon" href="${escapeHtml(href)}" rel="noopener noreferrer"${label ? ` aria-label="${escapeHtml(label)}"` : ""}>${svg}</a>`;
      return label
        ? `<span class="icon" role="img" aria-label="${escapeHtml(label)}">${svg}</span>`
        : `<span class="icon">${svg}</span>`;
    }
    case "socialLinks": {
      const items = (Array.isArray(p["items"]) ? p["items"] : []).flatMap((raw: unknown) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        const href = str(item["href"]).trim();
        const name = SOCIAL[str(item["network"]).toLowerCase()] ?? (str(item["network"]) || "Link");
        return isSafeUrl(href)
          ? [
              `<li><a href="${escapeHtml(href)}" rel="noopener noreferrer me">${escapeHtml(name)}</a></li>`,
            ]
          : [];
      });
      return items.length > 0 ? `<ul class="social-links">${items.join("")}</ul>` : "";
    }
    case "map": {
      // Nothing is sent to a map company until the visitor follows the link (spec 06, 14.3).
      const query = str(p["query"]).trim().slice(0, 200);
      if (!query) return "";
      const google = p["provider"] === "google";
      const href = google
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
        : `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
      return `<p class="map"><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Show the map: ${escapeHtml(query)}</a> <small>Opens ${google ? "Google Maps" : "OpenStreetMap"}.</small></p>`;
    }
    case "accordion": {
      // One open at a time: the browser's own grouping of details by name.
      const name = p["single"] === true ? ` name="a-${escapeHtml(block.id)}"` : "";
      return `<div class="accordion">${children.replace(/<details>/g, `<details${name}>`)}</div>`;
    }
    case "tabs":
      // Without script the tabs show one under another; each has its own heading.
      return `<div class="tabs">${children}</div>`;
    case "tab": {
      const title = str(p["title"]).trim() || "Tab";
      return `<section class="tab"><h3>${escapeHtml(title)}</h3>${children}</section>`;
    }
    case "slider":
      return `<div class="slider" role="region" aria-roledescription="carousel" aria-label="${escapeHtml(str(p["label"]) || "Slides")}" tabindex="0">${children}</div>`;
    case "slide":
      return `<div class="slide" role="group" aria-roledescription="slide">${children}</div>`;
    default:
      ctx.skipped.add(block.type);
      return "";
  }
}

// ---- the style of a block: a class from the generated page CSS, never an inline style (spec 06, 4.3) ----

const ALL_SIZES = BREAKPOINTS.map((b) => b.name);

/** The checked style of a block. Every screen size is accepted here; the site's own list decides which are drawn. */
const blockStyle = (block: Block): Style => checkStyle(props(block)["style"], ALL_SIZES).style;

/** Puts the block's id on the first element of a written block (only for the editor's preview). */
function withId(html: string, id: string | null): string {
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return html;
  const open = /^<([a-z][a-z0-9]*)/.exec(html);
  return open ? `<${open[1]} data-oks-id="${id}"${html.slice(open[0].length)}` : html;
}

/** Puts the style class on the first element of a written block. */
function withStyleClass(html: string, style: Style): string {
  const cls = styleClass(style);
  if (!cls) return html;
  const open = /^<([a-z][a-z0-9]*)([^>]*)>/.exec(html);
  if (!open) return html;
  const attributes = open[2]!;
  const next = / class="/.test(attributes)
    ? attributes.replace(/ class="/, ` class="${cls} `)
    : `${attributes} class="${cls}"`;
  return `<${open[1]}${next}>${html.slice(open[0].length)}`;
}

/** The CSS for the styles of a page's blocks: one class for each distinct style. `enabled` is the site's screen sizes. */
export function pageCss(blocks: Block[], enabled?: readonly string[]): string {
  const styles: Style[] = [];
  const types = new Set<string>();
  const walk = (list: Block[] | undefined, depth: number): void => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return;
    for (const block of list) {
      if (block === null || typeof block !== "object") continue;
      types.add(block.type);
      styles.push(blockStyle(block));
      walk(block.children, depth + 1);
    }
  };
  walk(blocks, 0);
  // The base rules of the layout blocks come first, so a block's own style can change them.
  return [layoutCss(types), generateCss(styles, enabled)].filter(Boolean).join("\n");
}

function blocksHtml(blocks: Block[] | undefined, parent: Context): string {
  if (!Array.isArray(blocks) || parent.depth >= MAX_DEPTH) return "";
  const ctx = { ...parent, depth: parent.depth + 1 };
  let out = "";
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block === null || typeof block !== "object") continue;
    if (LIST_TYPES.has(block.type)) {
      // Neighbouring items of one kind are one list.
      const items = [block];
      while (i + 1 < blocks.length && blocks[i + 1]?.type === block.type) items.push(blocks[++i]!);
      out += listHtml(items, ctx);
    } else
      out += withId(
        withStyleClass(
          blockHtml(
            { ...block, children: Array.isArray(block.children) ? block.children : [] },
            ctx,
          ),
          blockStyle(block),
        ),
        ctx.ids ? block.id : null,
      );
  }
  return out;
}

// ---- plain text ----

function blockText(block: Block, depth: number, lines: string[]): void {
  if (depth > MAX_DEPTH || block === null || typeof block !== "object") return;
  const p = props(block);
  const push = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t) lines.push(t);
  };
  switch (block.type) {
    case "image":
      push((p["decorative"] === true ? "" : str(p["alt"])) + " " + str(p["caption"]));
      break;
    case "embed":
    case "video":
      push(str(p["url"]) || str(p["caption"]));
      break;
    case "file":
      push(str(p["name"]));
      break;
    case "bookmark":
      push(str(p["title"]));
      push(str(p["description"]));
      break;
    case "table": {
      const rows = (block.content as { rows?: { cells?: unknown[] }[] } | null)?.rows;
      for (const row of Array.isArray(rows) ? rows : [])
        push((Array.isArray(row.cells) ? row.cells : []).map(inlineText).join(" "));
      break;
    }
    case "divider":
    case "spacer":
      break;
    case "button":
      push(str(p["text"]));
      break;
    case "gallery":
      for (const item of Array.isArray(p["images"]) ? p["images"] : [])
        push(
          `${str((item as Record<string, unknown>)?.["alt"])} ${str((item as Record<string, unknown>)?.["caption"])}`,
        );
      break;
    case "audio":
      push(str(p["title"]));
      break;
    case "icon":
      push(str(p["label"]));
      break;
    case "map":
      push(str(p["query"]));
      break;
    case "tab":
      push(str(p["title"]));
      break;
    case "socialLinks":
      break;
    default:
      push(inlineText(block.content));
  }
  for (const child of Array.isArray(block.children) ? block.children : [])
    blockText(child, depth + 1, lines);
}

/** The HTML and the plain text of a checked block list. Blocks the writer does not draw are listed in `skipped`. */
export function writeBlocks(blocks: Block[], options: { ids?: boolean } = {}): Written {
  const ctx: Context = { depth: 0, skipped: new Set(), ids: options.ids === true };
  const html = blocksHtml(blocks, ctx);
  const lines: string[] = [];
  for (const block of Array.isArray(blocks) ? blocks : []) blockText(block, 0, lines);
  return { html, plainText: lines.join("\n"), skipped: [...ctx.skipped].sort() };
}
