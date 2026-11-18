// GET /page-style/<entry id>/<fingerprint>.css: the style sheet of one published page. While the name matches the page's
// CSS the file never changes and is cached for a year; an older name gets the current one, not cached.
import { loadPageCss, pageStyleName } from "@oks-page/core";
import { getRunner, getSiteId } from "./db";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; file: string }> },
) {
  const { id, file } = await context.params;
  if (!/^[0-9a-f]{16}\.css$/.test(file) || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
    return new Response("Not found", { status: 404 });
  const css = await loadPageCss(getRunner(), await getSiteId(), id);
  if (!css) return new Response("Not found", { status: 404 });
  const current = pageStyleName(css) === file;
  return new Response(css, {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": current ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}
