// GET /site-style/<fingerprint>.css: the owner's look (colors, fonts, custom CSS) as a style sheet. The name carries the
// fingerprint of the text, so while it matches the current look the file never changes and is cached for a year. A page
// that still links to an older look gets the current one, not cached, so a visitor never sees a stale or missing style.
import { loadThemeCss } from "@oks-page/core";
import { getRunner, getSiteId } from "./db";
import { HIDE_CSS } from "./hide-css";
import { styleFileName } from "./site-style";

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  if (!/^[0-9a-f]{16}\.css$/.test(file)) return new Response("Not found", { status: 404 });
  // The rules that hide a block on some screens never change, so their file never changes either.
  if (file === styleFileName(HIDE_CSS))
    return new Response(HIDE_CSS, {
      status: 200,
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  const css = await loadThemeCss(getRunner(), await getSiteId());
  if (!css) return new Response("Not found", { status: 404 });
  const current = styleFileName(css) === file;
  return new Response(css, {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": current ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}
