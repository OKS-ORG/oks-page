// Free positioning warnings (spec 06, section 7): what is missing or overlapping, in plain sentences, for each screen size
// that is on.
import { describe, expect, test } from "vitest";
import type { Block } from "./blocks.js";
import { effectiveStyle, positionWarnings } from "./position.js";

const block = (id: string, style: unknown, children: Block[] = [], type = "container"): Block =>
  ({ id, type, props: style === undefined ? {} : { style }, content: null, children }) as Block;

const placed = (id: string, at: Record<string, string>) =>
  block(id, {
    base: { position: "absolute", width: "100px", height: "50px", ...at },
  });

describe("effectiveStyle", () => {
  test("a larger size is the smaller ones with its own values on top", () => {
    const style = { base: { padding: "1px", color: "red" }, desktop: { padding: "9px" } };
    expect(effectiveStyle(style, ["base", "tablet", "desktop"], "base")).toEqual({
      padding: "1px",
      color: "red",
    });
    expect(effectiveStyle(style, ["base", "tablet", "desktop"], "tablet")).toEqual({
      padding: "1px",
      color: "red",
    });
    expect(effectiveStyle(style, ["base", "tablet", "desktop"], "desktop")).toEqual({
      padding: "9px",
      color: "red",
    });
  });
});

describe("positionWarnings", () => {
  const room = (children: Block[]) =>
    block("room", { base: { position: "relative", "min-height": "300px" } }, children);

  test("a block that is not placed freely has nothing to warn about", () => {
    expect(positionWarnings([room([block("a", { base: { padding: "1px" } })])], "a")).toEqual([]);
  });

  test("a well placed block in a relative container with a height has no warning", () => {
    const a = placed("a", { top: "0px", "inset-inline-start": "0px" });
    expect(positionWarnings([room([a])], "a")).toEqual([]);
  });

  test("it says what is missing: size, place, a relative container, a height for the container", () => {
    const noSize = block("a", {
      base: { position: "absolute", top: "0px", "inset-inline-start": "0px" },
    });
    expect(positionWarnings([room([noSize])], "a")[0]).toMatch(/needs a width, a height/);
    const lost = block("a", { base: { position: "absolute", width: "1px", height: "1px" } });
    expect(positionWarnings([room([lost])], "a")[0]).toMatch(/place from the top or bottom/);
    const a = placed("a", { top: "0px", "inset-inline-start": "0px" });
    const plain = block("room", {}, [a]);
    expect(positionWarnings([plain], "a").join(" ")).toMatch(/must be set to a relative position/);
    const flat = block("room", { base: { position: "relative" } }, [a]);
    expect(positionWarnings([flat], "a").join(" ")).toMatch(/needs a height/);
    expect(positionWarnings([a], "a").join(" ")).toMatch(/needs to sit inside another block/);
  });

  test("two blocks that overlap are named; blocks side by side are not; each screen size is checked", () => {
    const a = placed("a", { top: "0px", "inset-inline-start": "0px" });
    const near = placed("b", { top: "20px", "inset-inline-start": "50px" });
    const apart = placed("c", { top: "0px", "inset-inline-start": "200px" });
    expect(positionWarnings([room([a, near])], "a").join(" ")).toMatch(/overlaps another block/);
    expect(positionWarnings([room([a, apart])], "a")).toEqual([]);
    // On a phone they are apart, on a desktop they overlap: the warning names the desktop.
    const x = block("x", {
      base: {
        position: "absolute",
        width: "100px",
        height: "50px",
        top: "0px",
        "inset-inline-start": "0px",
      },
    });
    const y = block("y", {
      base: {
        position: "absolute",
        width: "100px",
        height: "50px",
        top: "100px",
        "inset-inline-start": "0px",
      },
      desktop: { top: "10px" },
    });
    const warned = positionWarnings([room([x, y])], "x");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/^On desktop,/);
  });
});
