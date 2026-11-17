// Our own HTML writer (spec 03, section 5): blocks become the HTML that is stored in `entries.html` (feeds, email, the
// content API) and the plain text that is stored in `entries.plain_text` (search, excerpts).
//
// Every text and every attribute value is escaped. Only addresses and colours that pass the same checks as the block
// checks are written, so the writer is safe even for blocks that did not go through the checks. oks-ui's own HTML
// function is never used (EC-32).
import { isSafeColor, isSafeUrl, isSafeVideoUrl, type Block } from "@oks-page/content-safety";

export interface Written {
  html: string;
  plainText: string;
  /** Block types the writer does not draw (a plugin's own block, for example). They are left out, never guessed at. */
  skipped: string[];
}

const MAX_DEPTH = 12;
const LIST_TYPES = new Set(["bulletList", "numberedList", "taskList"]);
const CALLOUTS = new Set(["info", "warning", "error", "success", "tip"]);

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
      return `<div class="columns">${block.children.map((child) => `<div class="column">${blocksHtml([child], ctx)}</div>`).join("")}</div>`;
    default:
      ctx.skipped.add(block.type);
      return "";
  }
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
      out += blockHtml(
        { ...block, children: Array.isArray(block.children) ? block.children : [] },
        ctx,
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
      break;
    default:
      push(inlineText(block.content));
  }
  for (const child of Array.isArray(block.children) ? block.children : [])
    blockText(child, depth + 1, lines);
}

/** The HTML and the plain text of a checked block list. Blocks the writer does not draw are listed in `skipped`. */
export function writeBlocks(blocks: Block[]): Written {
  const ctx: Context = { depth: 0, skipped: new Set() };
  const html = blocksHtml(blocks, ctx);
  const lines: string[] = [];
  for (const block of Array.isArray(blocks) ? blocks : []) blockText(block, 0, lines);
  return { html, plainText: lines.join("\n"), skipped: [...ctx.skipped].sort() };
}
