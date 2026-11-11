import { describe, expect, test } from "vitest";
import { checkUpload, cleanFileName, detectType } from "./check.js";

const bytes = (...v: number[]) => new Uint8Array(v);
const text = (s: string) => new TextEncoder().encode(s);
const pad = (head: Uint8Array, n = 64) => {
  const out = new Uint8Array(Math.max(n, head.length));
  out.set(head);
  return out;
};

const JPEG = pad(bytes(0xff, 0xd8, 0xff, 0xe0));
const PNG = pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
const GIF = pad(text("GIF89a"));
const WEBP = pad(text("RIFF\0\0\0\0WEBPVP8 "));
const AVIF = pad(text("\0\0\0\x1cftypavif"));
const HEIC = pad(text("\0\0\0\x18ftypheic"));
const MP4 = pad(text("\0\0\0\x18ftypisom"));
const PDF = pad(text("%PDF-1.7\n"));
const MP3 = pad(text("ID3\x04\0\0"));
const SVG = text(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
);

const owner = { canUploadSvg: true };
const author = { canUploadSvg: false };

describe("the type is read from the bytes (MD-01)", () => {
  test.each([
    ["JPEG", JPEG, "image/jpeg"],
    ["PNG", PNG, "image/png"],
    ["GIF", GIF, "image/gif"],
    ["WebP", WEBP, "image/webp"],
    ["AVIF", AVIF, "image/avif"],
    ["PDF", PDF, "application/pdf"],
    ["MP4", MP4, "video/mp4"],
    ["MP3", MP3, "audio/mpeg"],
    ["SVG", SVG, "image/svg+xml"],
  ])("%s", (_n, data, mime) => {
    expect(detectType(data)).toMatchObject({ mime });
  });

  test("an MP3 without a tag is found by its frame", () => {
    expect(detectType(pad(bytes(0xff, 0xfb, 0x90)))).toMatchObject({ mime: "audio/mpeg" });
  });
  test("unknown content is not a type", () => {
    expect(detectType(text("hello world"))).toBeNull();
  });
});

describe("what is refused (MD-02 to MD-07)", () => {
  const refused = (name: string, data: Uint8Array, opts = owner) => {
    const r = checkUpload(name, data, opts);
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.reason;
  };

  test("PHP, HTML and scripts, even when named like an image", () => {
    refused("shell.php", text("<?php system($_GET['c']); ?>"));
    refused("page.html", text("<html><script>alert(1)</script></html>"));
    refused("photo.jpg", text("<script>alert(1)</script>"));
    refused("run.sh", text("#!/bin/sh\nrm -rf /\n"));
  });
  test("an executable", () => {
    refused("setup.exe", pad(text("MZ\x90\0")));
    refused("tool.jpg", pad(bytes(0x7f, 0x45, 0x4c, 0x46)));
  });
  test("an SVG saved as .jpg", () => {
    expect(refused("logo.jpg", SVG)).toMatch(/says it is \.jpg but its content is image\/svg\+xml/);
  });
  test("a PNG renamed .jpg", () => {
    expect(refused("photo.jpg", PNG)).toBe(
      "The file says it is .jpg but its content is image/png.",
    );
  });
  test("an empty file", () => {
    expect(refused("a.png", new Uint8Array(0))).toMatch(/empty/);
  });
  test("a file over the limit", () => {
    expect(refused("a.png", PNG, { ...owner, maxBytes: 10 } as never)).toMatch(/too big/);
    const big = checkUpload("a.png", PNG, { canUploadSvg: true, maxBytes: 10 });
    expect(big.ok).toBe(false);
  });
  test("a HEIC photo gets a plain message (MD-37)", () => {
    expect(refused("IMG_0001.HEIC", HEIC)).toMatch(/HEIC.*JPEG/);
  });
  test("SVG without the permission (MD-36)", () => {
    expect(refused("logo.svg", SVG, author)).toMatch(/not allowed to upload SVG/);
    expect(checkUpload("logo.svg", SVG, owner).ok).toBe(true);
  });
});

describe("what is accepted", () => {
  test("a JPEG with a script appended is still a JPEG", () => {
    const evil = pad(bytes(0xff, 0xd8, 0xff, 0xe0), 16);
    const data = new Uint8Array([...evil, ...text("<script>alert(1)</script>")]);
    const r = checkUpload("x.jpg", data, author);
    expect(r).toMatchObject({ ok: true, type: { mime: "image/jpeg" } });
  });
  test(".jpeg and upper case are fine and become .jpg", () => {
    expect(checkUpload("Photo.JPEG", JPEG, author)).toMatchObject({
      ok: true,
      fileName: "Photo.jpg",
    });
  });
  test("a name without extension gets the right one", () => {
    expect(checkUpload("photo", PNG, author)).toMatchObject({ ok: true, fileName: "photo.png" });
  });
  test("a PDF", () => {
    expect(checkUpload("Menu card.pdf", PDF, author)).toMatchObject({
      ok: true,
      fileName: "Menu-card.pdf",
      type: { kind: "pdf" },
    });
  });
});

describe("file names are cleaned (MD-06)", () => {
  const c = (s: string) => {
    const { base, ext } = cleanFileName(s);
    return ext ? `${base}.${ext}` : base;
  };
  test("folders and drive letters", () => {
    expect(c("C:\\Users\\me\\a.jpg")).toBe("a.jpg");
    expect(c("../../etc/passwd.png")).toBe("passwd.png");
  });
  test("control and forbidden characters", () => {
    expect(c('a<b>c:d"e|f?g*h.png')).toBe("abcdefgh.png");
    expect(c("a\u0000b\u0007.png")).toBe("ab.png");
  });
  test("leading dots", () => {
    expect(c("...hidden.png")).toBe("hidden.png");
  });
  test("Windows device names", () => {
    expect(c("CON.png")).toBe("_CON.png");
    expect(c("lpt1.png")).toBe("_lpt1.png");
  });
  test("spaces become dashes, extension lower case", () => {
    expect(c("my   holiday photo.JPG")).toBe("my-holiday-photo.jpg");
  });
  test("Hindi and accented names are kept", () => {
    expect(c("नमस्ते फोटो.JPG")).toBe("नमस्ते-फोटो.jpg");
    expect(c("café crème.png")).toBe("café-crème.png");
  });
  test("at most 120 characters", () => {
    expect([...c("a".repeat(300) + ".png")].length).toBe(120);
  });
  test("nothing left gives a plain name", () => {
    expect(c("???.png")).toBe("file.png");
  });
});
