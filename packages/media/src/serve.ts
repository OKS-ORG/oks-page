// Spec 09 section 8: the headers every stored file is served with. The type
// comes from the database (the checked type), never from the file name.

const INLINE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "audio/mpeg",
]);

/** A file name safe for a header: `filename*=UTF-8''my%20photo%20%C3%A9.png`. */
function encodeFileName(name: string): string {
  const safe = [...name]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join("");
  return encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** The response headers for a stored file. */
export function fileHeaders(mimeType: string, fileName: string): Record<string, string> {
  const disposition = INLINE.has(mimeType) ? "inline" : "attachment";
  return {
    "Content-Type": mimeType,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeFileName(fileName)}`,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "public, max-age=31536000, immutable",
  };
}
