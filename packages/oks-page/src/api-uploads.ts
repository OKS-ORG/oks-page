// GET /uploads/<key>: serves a stored file or one of its sizes. The type comes from the database, never from the file
// name, and every response carries the protective headers (spec 09, section 8). Theme files (`themes/<sha256>.<type>`)
// have no row: their type comes from the fixed list, and they are sent only when the bytes match the fingerprint.
import { findFile, themeFileMatches, themeFileType } from "@oks-page/core";
import { fileHeaders } from "@oks-page/media";
import { getRunner, getSiteId } from "./db";
import { mediaContext } from "./uploads";

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(_request: Request, context: { params: Promise<{ key: string[] }> }) {
  const { key: parts } = await context.params;
  let siteId: string;
  try {
    siteId = await getSiteId();
  } catch {
    return notFound();
  }
  const { storage } = mediaContext();
  const joined = parts.join("/");
  const themeType = themeFileType(joined);
  if (themeType) {
    let bytes: Uint8Array;
    try {
      bytes = await storage.get(joined);
    } catch {
      return notFound();
    }
    if (!themeFileMatches(joined, bytes)) return notFound();
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": themeType,
        "Content-Length": String(bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }
  // A name with a space or an accent is sent encoded. Try the key as given, then decoded once.
  const candidates = [parts.join("/")];
  try {
    const decoded = parts.map((p) => decodeURIComponent(p)).join("/");
    if (decoded !== candidates[0]) candidates.push(decoded);
  } catch {
    // Not valid percent-encoding: only the plain form is tried.
  }
  for (const key of candidates) {
    const file = await findFile(getRunner(), siteId, key);
    if (!file) continue;
    let bytes: Uint8Array;
    try {
      bytes = await storage.get(file.key);
    } catch {
      return notFound();
    }
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        ...fileHeaders(file.mimeType, file.fileName),
        "Content-Length": String(bytes.length),
      },
    });
  }
  return notFound();
}
