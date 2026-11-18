// Responsive styles (spec 06, section 4): breakpoints, allowed values, generated CSS (PB-01 to PB-17, PB-70, PB-71).
import { describe, expect, test } from "vitest";
import { checkBlocks } from "./index.js";
import {
  BREAKPOINTS,
  breakpointRanges,
  checkStyle,
  convertPhysicalStyle,
  generateCss,
  styleClass,
  styleKey,
  type Style,
} from "./styles.js";

describe("breakpoints (PB-01 to PB-05)", () => {
  test("the default three give 0-767, 768-1024 and 1025 and up", () => {
    expect(breakpointRanges()).toEqual([
      { name: "base", from: 0, to: 767 },
      { name: "tablet", from: 768, to: 1024 },
      { name: "desktop", from: 1025, to: null },
    ]);
  });

  test("all 64 on/off combinations: start at 0, no overlap, no gap, one range for every width", () => {
    const optional = BREAKPOINTS.slice(1).map((b) => b.name);
    for (let mask = 0; mask < 64; mask++) {
      const enabled = optional.filter((_, i) => mask & (1 << i));
      const ranges = breakpointRanges(enabled);
      expect(ranges[0]!.from).toBe(0);
      expect(ranges.at(-1)!.to).toBeNull();
      for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.from).toBe(ranges[i - 1]!.to! + 1);
      for (const width of [
        0, 1, 767, 768, 880, 881, 1024, 1025, 1200, 1201, 1366, 1367, 2399, 2400, 5000,
      ])
        expect(
          ranges.filter((r) => width >= r.from && (r.to === null || width <= r.to)),
        ).toHaveLength(1);
    }
  });

  test("base is always on, even if the list leaves it out", () => {
    expect(breakpointRanges(["desktop"])[0]!.name).toBe("base");
  });
});

describe("allowed properties and values (PB-06 to PB-12)", () => {
  test("allowed values are kept, space tokens become the theme's variable", () => {
    const r = checkStyle({
      base: {
        padding: "space.4",
        color: "#112233",
        "grid-template-columns": "repeat(3, minmax(0, 1fr))",
      },
      tablet: {
        "font-family": "heading",
        "background-image": "linear-gradient(90deg, #fff, rgb(0,0,0))",
      },
    });
    expect(r.messages).toEqual([]);
    expect(r.style.base).toEqual({
      padding: "var(--oks-space-4)",
      color: "#112233",
      "grid-template-columns": "repeat(3,minmax(0,1fr))",
    });
    expect(r.style.tablet!["font-family"]).toBe("var(--oks-site-font-heading)");
    expect(r.style.tablet!["background-image"]).toBe("linear-gradient(90deg,#fff,rgb(0,0,0))");
  });

  test.each([
    ["background-image", "url(https://x.test/a.png)"],
    ["width", "expression(alert(1))"],
    ["color", "javascript:alert(1)"],
    ["--x", "1"],
    ["background-image", "linear-gradient(90deg, var(--a), #fff)"],
    ["background-image", "linear-gradient(90deg, #fff)"],
    ["position", "fixed"],
    ["position", "sticky"],
    ["transform", "rotate(3deg)"],
    ["filter", "blur(2px)"],
    ["content", '"x"'],
    ["behavior", "url(x.htc)"],
    ["width", "9".repeat(201)],
    ["grid-template-columns", "repeat(13, minmax(0,1fr))"],
    ["font-family", "Comic Sans MS"],
  ])("%s: %s is removed with a sentence", (property, value) => {
    const r = checkStyle({ base: { [property]: value, padding: "0" } });
    expect(r.style.base).toEqual({ padding: "0" });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).not.toMatch(/undefined|\[object/);
  });

  test("styles for a screen size that is off or unknown are removed with a message", () => {
    const r = checkStyle({ base: { gap: "8px" }, laptop: { gap: "9px" }, huge: { gap: "1px" } });
    expect(r.style).toEqual({ base: { gap: "8px" } });
    expect(r.messages).toHaveLength(2);
    expect(checkStyle({ laptop: { gap: "9px" } }, ["laptop"]).style).toEqual({
      laptop: { gap: "9px" },
    });
  });

  test("a style that is not an object is cleared", () => {
    expect(checkStyle("red").style).toEqual({});
    expect(checkStyle(["x"]).messages).toHaveLength(1);
    expect(checkStyle(undefined).messages).toEqual([]);
  });
});

describe("right to left (PB-70, PB-71)", () => {
  test("physical horizontal properties are removed, start and end are accepted", () => {
    for (const p of [
      "margin-left",
      "margin-right",
      "padding-left",
      "padding-right",
      "left",
      "right",
    ])
      expect(checkStyle({ base: { [p]: "4px" } }).style).toEqual({});
    for (const v of ["left", "right"])
      expect(checkStyle({ base: { "text-align": v } }).style).toEqual({});
    const ok = checkStyle({
      base: {
        "margin-inline-start": "4px",
        "padding-inline-end": "8px",
        "inset-inline-start": "0",
        "text-align": "end",
      },
    });
    expect(ok.messages).toEqual([]);
    expect(Object.keys(ok.style.base!)).toHaveLength(4);
  });

  test("an old page is converted: left becomes start, right becomes end", () => {
    expect(
      convertPhysicalStyle({
        base: { "margin-left": "4px", right: "0", "text-align": "left", gap: "1px" },
      }),
    ).toEqual({
      base: {
        "margin-inline-start": "4px",
        "inset-inline-end": "0",
        "text-align": "start",
        gap: "1px",
      },
    });
  });
});

describe("generated CSS (PB-13, PB-14, PB-16)", () => {
  const a: Style = { base: { color: "#fff", gap: "8px" }, desktop: { gap: "16px" } };
  const aReordered: Style = { desktop: { gap: "16px" }, base: { gap: "8px", color: "#fff" } };

  test("the same style gives the same class whatever the key order; two styles never share one", () => {
    expect(styleClass(a)).toBe(styleClass(aReordered));
    expect(styleKey(a)).toBe(styleKey(aReordered));
    expect(styleClass(a)).toMatch(/^oks-s-[0-9a-f]{10}$/);
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++)
      seen.add(styleClass({ base: { padding: `${i}px`, gap: `${i % 7}px` } })!);
    expect(seen.size).toBe(3000);
    expect(styleClass({})).toBeNull();
  });

  test("base rules have no media query; larger sizes use min-width, ascending; never max-width", () => {
    const css = generateCss([a, { tablet: { gap: "4px" }, base: { gap: "2px" } }]);
    const rules = css.split("\n");
    expect(rules[0]).toMatch(/^\.oks-s-[0-9a-f]{10}\{color:#fff;gap:8px\}$/);
    expect(css).toContain("@media (min-width:768px){");
    expect(css).toContain("@media (min-width:1025px){");
    expect(css).not.toContain("max-width");
    const mins = [...css.matchAll(/min-width:(\d+)px/g)].map((m) => Number(m[1]));
    expect(mins).toEqual([...mins].sort((x, y) => x - y));
    expect(css.indexOf("min-width:768px")).toBeLessThan(css.indexOf("min-width:1025px"));
  });

  test("the same style used 30 times is written once", () => {
    const css = generateCss(Array.from({ length: 30 }, () => a));
    expect(css.split("\n")).toHaveLength(2);
  });

  test("when a screen size is off, its rules start where the previous one ends", () => {
    const css = generateCss([{ base: { gap: "1px" }, "tablet-lg": { gap: "2px" } }], ["tablet-lg"]);
    expect(css).toContain("@media (min-width:768px)");
  });
});

describe("the block checks use the style checker (PB-61)", () => {
  test("a saved page never keeps a style the checker refuses", () => {
    const { body, repairs } = checkBlocks({
      version: 1,
      blocks: [
        {
          id: "a",
          type: "container",
          props: { style: { base: { gap: "8px", position: "fixed", "margin-left": "3px" } } },
          children: [],
        },
        {
          id: "b",
          type: "paragraph",
          props: { style: { base: { transform: "x" } } },
          children: [],
        },
      ],
    });
    expect(body.blocks[0]!.props["style"]).toEqual({ base: { gap: "8px" } });
    expect(body.blocks[1]!.props["style"]).toBeUndefined();
    expect(repairs).toContain("removed_style");
  });

  test("the site's screen sizes decide what is kept", () => {
    // The checks repair the document they are given, so each call gets its own copy.
    const input = () => ({
      version: 1,
      blocks: [
        { id: "a", type: "container", props: { style: { laptop: { gap: "1px" } } }, children: [] },
      ],
    });
    expect(checkBlocks(input()).body.blocks[0]!.props["style"]).toBeUndefined();
    expect(
      checkBlocks(input(), { breakpoints: ["laptop"] }).body.blocks[0]!.props["style"],
    ).toEqual({
      laptop: { gap: "1px" },
    });
  });
});
