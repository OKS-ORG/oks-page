import { describe, expect, test } from "vitest";
import { fileHeaders } from "./serve.js";

describe("response headers (MD-20, MD-21)", () => {
  test("an image is shown inline with every protection", () => {
    expect(fileHeaders("image/png", "my photo é.png")).toEqual({
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline; filename*=UTF-8''my%20photo%20%C3%A9.png",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });
  test.each(["image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4", "audio/mpeg"])(
    "%s is inline",
    (mime) => {
      expect(fileHeaders(mime, "a")["Content-Disposition"]).toMatch(/^inline;/);
    },
  );
  test.each(["application/pdf", "image/svg+xml", "text/html", "application/octet-stream"])(
    "%s is always downloaded",
    (mime) => {
      expect(fileHeaders(mime, "a")["Content-Disposition"]).toMatch(/^attachment;/);
    },
  );
  test("a hostile file name cannot break the header", () => {
    const d = fileHeaders("image/png", 'a"; filename=evil.html\r\nX-Evil: 1')[
      "Content-Disposition"
    ]!;
    expect(d).not.toMatch(/[\r\n"]/);
    expect(d.split(";").length).toBe(2);
  });
});
