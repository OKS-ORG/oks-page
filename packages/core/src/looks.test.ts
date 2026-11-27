import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, parseColour, type Rgb } from "./accent.js";
import { fontByKey } from "./font-library.js";
import { DEFAULT_LOOK, isLook, LOOK_KEYS, LOOKS, lookVariables, looksCss } from "./looks.js";

const rgb = (hex: string): Rgb => parseColour(hex) as Rgb;
const MODES = ["light", "dark"] as const;
const CSS_FILE = fileURLToPath(new URL("../../admin/src/looks.css", import.meta.url));

describe("the looks of the admin (docs/18-new-look.md)", () => {
  it("are three, and Clear Sky is the default", () => {
    expect([...LOOK_KEYS]).toEqual(["clear-sky", "pine", "ember"]);
    expect(DEFAULT_LOOK).toBe("clear-sky");
    expect(isLook("pine")).toBe(true);
    expect(isLook("indigo")).toBe(false);
    expect(isLook(undefined)).toBe(false);
  });

  it("use only fonts of the built-in library, so the admin never calls another company", () => {
    for (const key of LOOK_KEYS) {
      expect(fontByKey(LOOKS[key].fonts.heading), key).toBeDefined();
      expect(fontByKey(LOOKS[key].fonts.text), key).toBeDefined();
    }
  });

  it("follow the corner rule: a card is a control plus 4", () => {
    expect(LOOKS["clear-sky"].radius).toBe(12);
    expect(LOOKS.pine.radius).toBe(10);
    expect(LOOKS.ember.radius).toBe(8);
    for (const key of LOOK_KEYS) {
      const v = lookVariables(LOOKS[key], "light");
      expect(parseInt(v["--adm-radius-card"] as string, 10), key).toBe(LOOKS[key].radius + 4);
    }
  });

  for (const key of LOOK_KEYS) {
    for (const mode of MODES) {
      describe(`${key}, ${mode}`, () => {
        const c = LOOKS[key][mode];
        const pair = (name: string, fg: string, bg: string, min: number) =>
          it(`${name} reads at ${min}:1 or better`, () => {
            expect(contrast(rgb(fg), rgb(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
          });
        pair("text on the card", c.text, c.card, 4.5);
        pair("text on the ground", c.text, c.ground, 4.5);
        pair("muted text on the card", c.muted, c.card, 4.5);
        pair("muted text on the ground", c.muted, c.ground, 4.5);
        pair("the label on the accent", c.on, c.accent, 4.5);
        pair("the accent as text on the card", c.selText, c.card, 4.5);
        pair("the accent text on the selected fill", c.selText, c.sel, 4.5);
        pair("the edge of a field against the card (3:1 for controls)", c.border, c.card, 3);
        pair("success", c.okFg, c.okBg, 4.5);
        pair("careful", c.warnFg, c.warnBg, 4.5);
        pair("problem", c.errFg, c.errBg, 4.5);
        pair("info", c.infoFg, c.infoBg, 4.5);
      });
    }
  }

  it("write the variables oks-ui and the admin read, in both modes", () => {
    const v = lookVariables(LOOKS["clear-sky"], "light");
    expect(v["--adm-a1"]).toBe("#0b57d0");
    expect(v["--oks-color-primary-600"]).toBe("#0b57d0");
    expect(v["--adm-font-text"]).toContain("Figtree");
    // One accent: no second colour for a gradient.
    expect(v["--adm-a2"]).toBe(v["--adm-a1"]);
    const d = lookVariables(LOOKS.ember, "dark");
    expect(d["--adm-card"]).toBe("#1d2026");
    expect(d["--adm-radius"]).toBe("8px");
  });

  it("keep looks.css as the table says (run with UPDATE_LOOKS=1 to rewrite it)", () => {
    if (process.env["UPDATE_LOOKS"]) writeFileSync(CSS_FILE, looksCss());
    expect(readFileSync(CSS_FILE, "utf8")).toBe(looksCss());
  });
});
