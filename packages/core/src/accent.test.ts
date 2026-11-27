import { describe, expect, it } from "vitest";
import {
  accentScale,
  contrast,
  deriveAccent,
  luminance,
  mix,
  onColour,
  parseColour,
  SCALE_STEPS,
  toHex,
} from "./accent.js";

const WHITE_CARD = { card: "#ffffff", ground: "#f6f8fc", dark: false };
const DARK_CARD = { card: "#1e1f20", ground: "#131314", dark: true };

describe("colour maths", () => {
  it("reads and writes six-digit colours, with or without the hash", () => {
    expect(parseColour("#0b57d0")).toEqual([11, 87, 208]);
    expect(parseColour("0B57D0")).toEqual([11, 87, 208]);
    expect(parseColour("#fff")).toBeNull();
    expect(parseColour("blue")).toBeNull();
    expect(toHex([11, 87, 208])).toBe("#0b57d0");
    expect(toHex([300, -4, 12.4])).toBe("#ff000c");
  });
  it("contrast of black on white is 21 and of a colour on itself is 1", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([12, 90, 200], [12, 90, 200])).toBe(1);
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 5);
  });
  it("mixes part of the way", () => {
    expect(mix([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
  });
  it("puts white text on a dark colour and near-black text on a light one", () => {
    expect(onColour([11, 87, 208])).toEqual([255, 255, 255]);
    expect(toHex(onColour(parseColour("#ff6b57")!))).toBe("#14161a");
  });
});

describe("the accent worked out from one colour (light mode)", () => {
  it("keeps a colour that is already readable, and says so", () => {
    const t = deriveAccent("#0b57d0", WHITE_CARD)!;
    expect(t.accent).toBe("#0b57d0");
    expect(t.adjusted).toBe(false);
    expect(t.on).toBe("#ffffff");
    expect(t.contrastAfter).toBeGreaterThanOrEqual(4.5);
  });
  it("darkens a pale colour until its label and its text are readable, and says it moved", () => {
    const t = deriveAccent("#f2a65a", WHITE_CARD)!;
    expect(t.adjusted).toBe(true);
    expect(t.original).toBe("#f2a65a");
    expect(t.contrastBefore).toBeLessThan(4.5);
    expect(t.contrastAfter).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColour(t.accent)!, parseColour("#ffffff")!)).toBeGreaterThanOrEqual(4.5);
  });
  it("makes a tint and a text on it that stay readable, for any colour", () => {
    for (const hex of [
      "#0b57d0",
      "#0f6b5c",
      "#c8372d",
      "#6a4fb3",
      "#a15c00",
      "#00677d",
      "#f2a65a",
      "#ffff00",
      "#00ff00",
      "#808080",
      "#000000",
      "#ffffff",
    ]) {
      const t = deriveAccent(hex, WHITE_CARD)!;
      expect(contrast(parseColour(t.selText)!, parseColour(t.sel)!), hex).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(parseColour(t.accent)!, parseColour("#ffffff")!), hex).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(parseColour(t.on)!, parseColour(t.accent)!), hex).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("refuses what is not a colour", () => {
    expect(deriveAccent("blue", WHITE_CARD)).toBeNull();
    expect(deriveAccent("#0b57d0", { card: "x", ground: "#ffffff", dark: false })).toBeNull();
  });
});

describe("the accent worked out from one colour (dark mode)", () => {
  it("lightens a dark colour so it reads on the dark card, with a dark label", () => {
    const t = deriveAccent("#1d4ed8", DARK_CARD)!;
    expect(t.adjusted).toBe(true);
    expect(contrast(parseColour(t.accent)!, parseColour("#1e1f20")!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColour(t.on)!, parseColour(t.accent)!)).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps a light colour as it is", () => {
    const t = deriveAccent("#a8c7fa", DARK_CARD)!;
    expect(t.accent).toBe("#a8c7fa");
    expect(t.adjusted).toBe(false);
  });
  it("keeps every colour readable", () => {
    for (const hex of [
      "#0b57d0",
      "#0f6b5c",
      "#c8372d",
      "#6a4fb3",
      "#000000",
      "#ffffff",
      "#ff0000",
    ]) {
      const t = deriveAccent(hex, DARK_CARD)!;
      expect(contrast(parseColour(t.selText)!, parseColour(t.sel)!), hex).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(parseColour(t.accent)!, parseColour("#1e1f20")!), hex).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});

describe("the shade scale oks-ui wants", () => {
  it("has the eleven steps, the accent at 600, lighter above it and darker below", () => {
    const s = accentScale("#0b57d0")!;
    expect(Object.keys(s).map(Number)).toEqual([...SCALE_STEPS]);
    expect(s[600]).toBe("#0b57d0");
    expect(luminance(parseColour(s[50])!)).toBeGreaterThan(luminance(parseColour(s[500])!));
    expect(luminance(parseColour(s[950])!)).toBeLessThan(luminance(parseColour(s[700])!));
    expect(accentScale("nope")).toBeNull();
  });
});
