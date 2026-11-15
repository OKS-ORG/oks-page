// GET /fonts/<name>: a font file of the built-in library (ADR 0028). The name is `<font>-<script>-<weight>.<fingerprint>.woff2`
// and must be exactly one of the library's; the bytes are checked against their fingerprint before they are sent, and
// they never change under a name, so they are cached for a year. Nothing here reads the database or the visitor.
import { createHash } from "node:crypto";
import { fontFileByName } from "@oks-page/core/theme";

const notFound = () => new Response("Not found", { status: 404 });
const checked = new Map<string, Uint8Array>();

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file: name } = await context.params;
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
