// Public pages and image sizes (spec 09): the stored HTML of a page has plain `<img>` tags, because the smaller
// sizes are made later, in the background. When a page is shown, each image from the library that has its sizes is
// written as a `<picture>`: the browser takes the smallest size that fits the screen, in AVIF or WebP when it can,
// and a tiny blurred copy shows while the real one loads. The width and height are set so the page does not jump.
import type { SqlRunner } from "@oks-page/db";
import type { StorageAdapter } from "@oks-page/media";

const IMG = /<img src="([^"]*)" alt="([^"]*)" loading="lazy">/g;
const SIZES = "(min-width: 960px) 960px, 100vw";

const unescapeHtml = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
const escapeAttr = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

interface Known {
  id: string;
  width: number | null;
  height: number | null;
  blur: string | null;
}

/** The storage key a page's image address stands for, or null when it is not a file of this library. */
function keyOf(src: string, base: string): string | null {
  if (!src.startsWith(base)) return null;
  try {
    return src
      .slice(base.length)
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
  } catch {
    return null;
  }
}

export async function enhanceImages(
  runner: SqlRunner,
  siteId: string,
  html: string,
  storage: StorageAdapter,
): Promise<string> {
  if (!html.includes("<img ")) return html;
  const base = storage.publicUrl("a").slice(0, -1);
  const keys = new Map<string, string>(); // storage key -> the address as written in the page
  for (const match of html.matchAll(IMG)) {
    const key = keyOf(unescapeHtml(match[1]!), base);
    if (key) keys.set(key, match[1]!);
  }
  if (keys.size === 0) return html;
  const list = [...keys.keys()];
  const marks = list.map(() => "?").join(", ");
  const rows = await runner.all(
    `select "id", "storage_key", "width", "height", "blur_placeholder" from "media"
      where "site_id" = ? and "status" = 'ready' and "storage_key" in (${marks})`,
    [siteId, ...list],
  );
  if (rows.length === 0) return html;
  const known = new Map<string, Known>();
  for (const r of rows)
    known.set(String(r["storage_key"]), {
      id: String(r["id"]),
      width: r["width"] == null ? null : Number(r["width"]),
      height: r["height"] == null ? null : Number(r["height"]),
      blur: r["blur_placeholder"] == null ? null : String(r["blur_placeholder"]),
    });
  const ids = [...known.values()].map((k) => k.id);
  const variantRows = await runner.all(
    `select "media_id", "width", "format", "storage_key" from "media_variants"
      where "media_id" in (${ids.map(() => "?").join(", ")}) order by "width"`,
    ids,
  );
  const variants = new Map<string, { width: number; format: string; url: string }[]>();
  for (const v of variantRows) {
    const id = String(v["media_id"]);
    const entry = variants.get(id) ?? [];
    entry.push({
      width: Number(v["width"]),
      format: String(v["format"]),
      url: storage.publicUrl(String(v["storage_key"])),
    });
    variants.set(id, entry);
  }

  return html.replace(IMG, (whole, src: string, alt: string) => {
    const key = keyOf(unescapeHtml(src), base);
    const item = key ? known.get(key) : undefined;
    if (!item) return whole;
    const size = item.width && item.height ? ` width="${item.width}" height="${item.height}"` : "";
    const blur =
      item.blur && /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(item.blur)
        ? ` style="background-image:url('${item.blur}');background-size:cover"`
        : "";
    const img = `<img src="${src}" alt="${alt}" loading="lazy" decoding="async"${size}${blur}>`;
    const mine = variants.get(item.id) ?? [];
    const sources = ["avif", "webp"]
      .map((format) => {
        const sized = mine.filter((v) => v.format === format);
        if (sized.length === 0) return "";
        const srcset = sized.map((v) => `${escapeAttr(v.url)} ${v.width}w`).join(", ");
        return `<source type="image/${format}" srcset="${srcset}" sizes="${SIZES}">`;
      })
      .join("");
    return sources ? `<picture>${sources}${img}</picture>` : img;
  });
}
