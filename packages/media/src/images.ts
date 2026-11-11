// Spec 09 section 6: images. Sizes, upright photos, no metadata, a blur
// placeholder, and a refusal of image bombs and cut-off files.

import type SharpFactory from "sharp";
import type { Metadata } from "sharp";
import { DEFAULT_MAX_PIXELS } from "./check.js";

/** Variant widths. Never wider than the original. */
export const VARIANT_WIDTHS = [320, 640, 960, 1280, 1920, 2560] as const;
export const VARIANT_FORMATS = ["webp", "avif"] as const;
export type VariantFormat = (typeof VARIANT_FORMATS)[number];

export interface Variant {
  width: number;
  format: VariantFormat;
  bytes: Uint8Array;
}

export interface ProcessOptions {
  maxPixels?: number;
  /** Keep camera, date and location data (a site setting, off by default). */
  keepMetadata?: boolean;
}

export interface Prepared {
  /** Width and height as people see the picture (after turning it upright). */
  width: number;
  height: number;
  /** The bytes to store as the original: a JPEG is turned upright and stripped. */
  original: Uint8Array;
  /** True when the picture is animated: it is stored as it is, without variants. */
  animated: boolean;
}

export class ImageRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRefused";
  }
}

const READ_FAILED = "This image could not be read. It may be damaged or cut off.";

function limitMessage(max: number): string {
  return `The image has too many pixels. The most allowed is ${Math.floor(max / 1_000_000)} megapixels.`;
}

type Sharp = typeof SharpFactory;
let sharpLoaded: Promise<Sharp> | null = null;
// sharp is a large native library: it is loaded when the first image arrives, not when the site starts.
const loadSharp = (): Promise<Sharp> =>
  (sharpLoaded ??= import("sharp").then((m) => m.default as unknown as Sharp));

/** Runs the image work. Any failure while decoding means the file is damaged. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ImageRefused) throw error;
    throw new ImageRefused(READ_FAILED);
  }
}

async function open(bytes: Uint8Array, max: number) {
  // Only the header is read here, so a forged size is refused before any decoding.
  const img = (await loadSharp())(bytes, { limitInputPixels: false, failOn: "error" });
  let meta: Metadata;
  try {
    meta = await img.metadata();
  } catch {
    throw new ImageRefused(READ_FAILED);
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  // The size comes from the header, so a forged header is refused before any decoding.
  if (!w || !h) throw new ImageRefused(READ_FAILED);
  if (w * h > max) throw new ImageRefused(limitMessage(max));
  const turned = (meta.orientation ?? 1) >= 5;
  return {
    meta,
    width: turned ? h : w,
    height: turned ? w : h,
    animated: (meta.pages ?? 1) > 1,
  };
}

/** Measures the image and prepares the original for storage. Runs while the upload waits. */
export async function prepareImage(
  bytes: Uint8Array,
  options: ProcessOptions = {},
): Promise<Prepared> {
  const max = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const { meta, width, height, animated } = await open(bytes, max);
  let original = bytes;
  if (meta.format === "jpeg") {
    try {
      let pipe = (await loadSharp())(bytes, { limitInputPixels: max, failOn: "error" }).rotate();
      if (options.keepMetadata) pipe = pipe.keepMetadata();
      original = new Uint8Array(await pipe.jpeg({ quality: 92, mozjpeg: false }).toBuffer());
    } catch (error) {
      if (error instanceof ImageRefused) throw error;
      throw new ImageRefused(READ_FAILED);
    }
  }
  return { width, height, original, animated };
}

/** The widths to make for an image of the given width. */
export function variantWidths(width: number): number[] {
  const cap = VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1]!;
  const widths: number[] = VARIANT_WIDTHS.filter((w) => w < width);
  if (width <= cap) widths.push(width);
  return widths;
}

/** Makes all sizes in WebP and AVIF. This is slow for big images: it runs as a background job. */
export async function makeVariants(
  bytes: Uint8Array,
  options: ProcessOptions = {},
): Promise<Variant[]> {
  const max = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const { width, animated } = await open(bytes, max);
  if (animated) return [];
  return guarded(async () => {
    const out: Variant[] = [];
    for (const w of variantWidths(width)) {
      for (const format of VARIANT_FORMATS) {
        let pipe = (await loadSharp())(bytes, { limitInputPixels: max, failOn: "error" })
          .rotate()
          .resize({ width: w, withoutEnlargement: true });
        if (options.keepMetadata) pipe = pipe.keepMetadata();
        pipe =
          format === "webp" ? pipe.webp({ quality: 80 }) : pipe.avif({ quality: 55, effort: 2 });
        out.push({ width: w, format, bytes: new Uint8Array(await pipe.toBuffer()) });
      }
    }
    return out;
  });
}

/** A 16 pixel wide WebP as a data address, shown while the real image loads. */
export async function makeBlurPlaceholder(
  bytes: Uint8Array,
  options: ProcessOptions = {},
): Promise<string> {
  const max = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  await open(bytes, max);
  const tiny = await guarded(async () =>
    (await loadSharp())(bytes, { limitInputPixels: max, failOn: "error", pages: 1 })
      .rotate()
      .resize({ width: 16 })
      .webp({ quality: 40 })
      .toBuffer(),
  );
  return `data:image/webp;base64,${tiny.toString("base64")}`;
}
