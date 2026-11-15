import { describe, expect, test } from "vitest";
import {
  COLOR_MODE_SCRIPT,
  COLOR_MODE_STORAGE_KEY,
  colorModeCss,
  isColorMode,
  needsColorMode,
} from "./color-mode.js";
import { DEFAULT_THEME_STYLES, stylesToCss } from "./theme.js";

/** Runs the script as a browser would, against a small stand-in for the page, and returns the mode it set. */
function run(opts: {
  mode: string;
  switchOn?: boolean;
  stored?: string | "throws";
  systemDark?: boolean;
}) {
  const attributes: Record<string, string> = {};
  const listeners: (() => void)[] = [];
  const query = {
    matches: opts.systemDark ?? false,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  };
  const script = { dataset: { mode: opts.mode, switch: opts.switchOn ? "1" : "0" } };
  const doc = {
    currentScript: script,
    documentElement: { setAttribute: (k: string, v: string) => (attributes[k] = v) },
  };
  const storage = {
    getItem: (key: string) => {
      if (opts.stored === "throws") throw new Error("blocked");
      return key === COLOR_MODE_STORAGE_KEY ? (opts.stored ?? null) : null;
    },
  };
  new Function("document", "matchMedia", "localStorage", COLOR_MODE_SCRIPT)(
    doc,
    () => query,
    storage,
  );
  return {
    theme: () => attributes["data-theme"],
    deviceChanges: (dark: boolean) => {
      query.matches = dark;
      listeners.forEach((fn) => fn());
    },
    listening: listeners.length,
  };
}

describe("light and dark mode of the public pages (spec 05, section 5)", () => {
  test("the three modes, and when the pages need the script", () => {
    expect(["light", "dark", "system", "auto", "", 1].map(isColorMode)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(needsColorMode("light", false)).toBe(false);
    expect(needsColorMode("light", true)).toBe(true);
    expect(needsColorMode("dark", false)).toBe(true);
    expect(needsColorMode("system", false)).toBe(true);
  });

  test("a site that is always light and has no switch is exactly as before: no CSS, no script", () => {
    expect(colorModeCss("light", false)).toBe("");
    expect(stylesToCss({ ...DEFAULT_THEME_STYLES, colorMode: "light", modeSwitch: false })).toBe(
      "",
    );
    // A new site follows the visitor's device and shows the switch (D68), so it writes the dark rules.
    expect(DEFAULT_THEME_STYLES).toMatchObject({ colorMode: "system", modeSwitch: true });
    expect(stylesToCss(DEFAULT_THEME_STYLES)).toBe(colorModeCss("system", true));
  });

  test("the dark CSS: the dark page and text colors, links from the dark scale, the browser's dark controls", () => {
    for (const css of [
      colorModeCss("dark", false),
      colorModeCss("system", true),
      colorModeCss("light", true),
    ]) {
      expect(css).toContain(':root[data-theme="dark"]{color-scheme:dark}');
      expect(css).toContain("var(--oks-color-surface)");
      expect(css).toContain("var(--oks-palette-neutral-900)");
      expect(css).toContain("var(--oks-color-primary-700)");
      expect(css).not.toMatch(/https?:|@import|url\(/);
    }
    expect(stylesToCss({ ...DEFAULT_THEME_STYLES, colorMode: "dark" })).toContain(
      "color-scheme:dark",
    );
  });

  test("the script is fixed text, with no place to put anything in it, and sets the mode before the page is drawn", () => {
    expect(COLOR_MODE_SCRIPT).not.toMatch(/\$\{|<\/|`/);
    expect(COLOR_MODE_SCRIPT.length).toBeLessThan(700);
    expect(run({ mode: "dark" }).theme()).toBe("dark");
    expect(run({ mode: "light" }).theme()).toBe("light");
    expect(run({ mode: "system", systemDark: true }).theme()).toBe("dark");
    expect(run({ mode: "system", systemDark: false }).theme()).toBe("light");
  });

  test("a choice the visitor made wins, only when the owner turned the switch on", () => {
    expect(run({ mode: "light", switchOn: true, stored: "dark" }).theme()).toBe("dark");
    expect(run({ mode: "dark", switchOn: true, stored: "light" }).theme()).toBe("light");
    expect(run({ mode: "system", switchOn: true, stored: "light", systemDark: true }).theme()).toBe(
      "light",
    );
    // No switch: a stored choice (from an earlier time) is ignored.
    expect(run({ mode: "light", switchOn: false, stored: "dark" }).theme()).toBe("light");
    // A stored value that is not one of the two, or storage that is blocked, changes nothing.
    expect(run({ mode: "dark", switchOn: true, stored: "purple" }).theme()).toBe("dark");
    expect(run({ mode: "dark", switchOn: true, stored: "throws" }).theme()).toBe("dark");
  });

  test("following the device: it changes with the device, and only in system mode", () => {
    const system = run({ mode: "system", systemDark: false });
    expect(system.listening).toBe(1);
    system.deviceChanges(true);
    expect(system.theme()).toBe("dark");
    system.deviceChanges(false);
    expect(system.theme()).toBe("light");
    expect(run({ mode: "dark" }).listening).toBe(0);
  });
});
