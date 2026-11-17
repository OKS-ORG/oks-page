// GET /fonts/<name>: a font file of the built-in library (ADR 0028). The name is `<font>-<script>-<weight>.<fingerprint>.woff2`
// and must be exactly one of the library's; the bytes are checked against their fingerprint before they are sent, and
// they never change under a name, so they are cached for a year. Nothing here reads the database or the visitor.
import { createHash } from "node:crypto";
import { fontFileByName } from "@oks-page/core/theme";
import { loadOwnerFontFile } from "@oks-page/core";
import { getRunner } from "./db";

const notFound = () => new Response("Not found", { status: 404 });
const checked = new Map<string, Uint8Array>();

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file: name } = await context.params;
  // A font the owner uploaded: `own-<kind>-<weight>-<16 letters>.woff2`, read from the site's own settings.
  const own = /^own-(?:sans|serif|mono)-(?:400|700|vf)-([0-9a-f]{16})\.woff2$/.exec(name);
  if (own) {
    const data = await loadOwnerFontFile(getRunner(), own[1]!);
    return data ? fontResponse(data) : notFound();
  }
  const found = fontFileByName(name);
  if (!found) return notFound();
  let bytes = checked.get(found.file.sha256);
  if (!bytes) {
    const { FONT_FILES } = await import("@oks-page/core/font-files");
    const encoded = FONT_FILES[found.file.sha256];
    if (!encoded) return notFound();
    const data = Buffer.from(encoded, "base64");
    if (createHash("sha256").update(data).digest("hex") !== found.file.sha256) return notFound();
    bytes = data;
    checked.set(found.file.sha256, bytes);
  }
  return fontResponse(bytes);
}

function fontResponse(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "font/woff2",
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
