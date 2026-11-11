import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { detectType } from "./check.js";
import {
  ImageRefused,
  makeBlurPlaceholder,
  makeVariants,
  prepareImage,
  variantWidths,
} from "./images.js";

// A picture with a gradient, so that it does not shrink to nothing.
const picture = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });

const jpeg = (w: number, h: number) => picture(w, h).jpeg().toBuffer();

describe("which sizes are made (MD-08, MD-09)", () => {
  test("a big image gets every size up to 2560", () => {
    expect(variantWidths(6000)).toEqual([320, 640, 960, 1280, 1920, 2560]);
  });
  test("never wider than the original", () => {
    expect(variantWidths(1000)).toEqual([320, 640, 960, 1000]);
  });
  test("a small image (500 px) gets 320 and 500", () => {
    expect(variantWidths(500)).toEqual([320, 500]);
  });
  test("a tiny image gets only its own width", () => {
    expect(variantWidths(100)).toEqual([100]);
  });
  test("exactly 2560 is not made twice", () => {
    expect(variantWidths(2560)).toEqual([320, 640, 960, 1280, 1920, 2560]);
  });
});

describe("variants (MD-08)", () => {
  test("WebP and AVIF in each width, none wider than the original", async () => {
    const v = await makeVariants(await jpeg(1000, 500));
    expect(v.map((x) => `${x.width}.${x.format}`)).toEqual([
      "320.webp",
      "320.avif",
      "640.webp",
      "640.avif",
      "960.webp",
      "960.avif",
      "1000.webp",
      "1000.avif",
    ]);
    for (const x of v) {
      const m = await sharp(x.bytes).metadata();
      expect(m.width).toBe(x.width);
      expect(m.format === "webp" || m.format === "heif").toBe(true);
    }
  });

  test("a small image is not scaled up", async () => {
    const v = await makeVariants(await jpeg(500, 300));
    expect(Math.max(...v.map((x) => x.width))).toBe(500);
  });

  test("an animated GIF gets no variants (stored as it is)", async () => {
    const frame = (r: number) =>
      sharp({ create: { width: 10, height: 10, channels: 3, background: { r, g: 0, b: 0 } } })
        .png()
        .toBuffer();
    const gif = await sharp([await frame(255), await frame(0)], { join: { animated: true } })
      .gif()
      .toBuffer();
    const p = await prepareImage(gif);
    expect(p.animated).toBe(true);
    expect(await makeVariants(gif)).toEqual([]);
  });
});

describe("orientation and metadata (MD-11 to MD-13)", () => {
  // A photo marked "turned" (orientation 6) with location data.
  const photo = () =>
    picture(400, 200)
      .withExif({
        IFD0: { Copyright: "me", Make: "Camera Co" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "28/1 36/1 0/1" },
      })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

  test("the photo is measured turned: 200 by 400, not 400 by 200", async () => {
    const p = await prepareImage(await photo());
    expect({ w: p.width, h: p.height }).toEqual({ w: 200, h: 400 });
    // The pixels are turned upright too.
    const m = await sharp(p.original).metadata();
    expect({ w: m.width, h: m.height }).toEqual({ w: 200, h: 400 });
    expect(m.orientation ?? 1).toBe(1);
  });

  test("the stored original has no EXIF, no location", async () => {
    const source = await photo();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const p = await prepareImage(source);
    const m = await sharp(p.original).metadata();
    expect(m.exif).toBeUndefined();
    expect(Buffer.from(p.original).includes(Buffer.from("Camera Co"))).toBe(false);
    expect(Buffer.from(p.original).includes(Buffer.from("GPS"))).toBe(false);
  });

  test("every variant has no EXIF and is upright", async () => {
    const v = await makeVariants(await photo());
    expect(v.length).toBeGreaterThan(0);
    for (const x of v) {
      const m = await sharp(x.bytes).metadata();
      expect(m.exif).toBeUndefined();
      expect(m.height).toBeGreaterThan(m.width ?? 0);
    }
  });

  test("a site setting can keep the metadata", async () => {
    const p = await prepareImage(await photo(), { keepMetadata: true });
    expect((await sharp(p.original).metadata()).exif).toBeDefined();
  });

  test("a PNG is stored as it is", async () => {
    const png = await picture(50, 50).png().toBuffer();
    const p = await prepareImage(png);
    expect(Buffer.from(p.original).equals(png)).toBe(true);
    expect(detectType(p.original)).toMatchObject({ mime: "image/png" });
  });
});

describe("the blur placeholder (MD-10)", () => {
  test("is a small WebP data address", async () => {
    const url = await makeBlurPlaceholder(await jpeg(800, 600));
    expect(url).toMatch(/^data:image\/webp;base64,/);
    expect(url.length).toBeLessThan(400);
    const m = await sharp(Buffer.from(url.split(",")[1]!, "base64")).metadata();
    expect(m.width).toBe(16);
  });
});

describe("what is refused (MD-14, MD-15)", () => {
  // A PNG whose header claims a huge size, with nothing behind it.
  const forgedPng = (w: number, h: number) => {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  };

  test("an image bomb (40,000 by 40,000) is refused before decoding", async () => {
    const bomb = forgedPng(40_000, 40_000);
    const started = Date.now();
    await expect(prepareImage(bomb)).rejects.toThrow(/too many pixels/);
    await expect(makeVariants(bomb)).rejects.toBeInstanceOf(ImageRefused);
    await expect(makeBlurPlaceholder(bomb)).rejects.toBeInstanceOf(ImageRefused);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a lower limit from the settings is used", async () => {
    await expect(prepareImage(await jpeg(2000, 1000), { maxPixels: 1_000_000 })).rejects.toThrow(
      /1 megapixels/,
    );
  });

  test("a cut-off JPEG is refused, not half-processed", async () => {
    const whole = await picture(600, 600)
      .composite([
        {
          input: await sharp(
            Buffer.from(Array.from({ length: 300 * 300 * 3 }, (_, i) => (i * 7) % 256)),
            {
              raw: { width: 300, height: 300, channels: 3 },
            },
          )
            .png()
            .toBuffer(),
        },
      ])
      .jpeg()
      .toBuffer();
    const cut = whole.subarray(0, Math.floor(whole.length / 2));
    await expect(prepareImage(cut)).rejects.toThrow(/could not be read/);
    await expect(makeVariants(cut)).rejects.toThrow(/could not be read/);
  });

  test("something that is not an image is refused", async () => {
    await expect(prepareImage(new TextEncoder().encode("hello"))).rejects.toThrow(
      /could not be read/,
    );
  });
});
