import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";
import { DEFAULT_THEME_STYLES } from "./theme.js";
import {
  loadThemeCss,
  loadThemeStyles,
  readThemeStyles,
  saveThemeStyles,
} from "./theme-settings.js";
import { colorModeCss } from "./color-mode.js";

/** What a new site writes: only the rules for dark mode, as the default follows the visitor's device (D68). */
const NEW_SITE_CSS = colorModeCss("system", true);

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("reading a stored look", () => {
  test("anything damaged or unknown means the built-in look, field by field", () => {
    expect(readThemeStyles(null)).toEqual(DEFAULT_THEME_STYLES);
    expect(readThemeStyles("not json")).toEqual(DEFAULT_THEME_STYLES);
    expect(readThemeStyles({ mainColor: "red;}", bodyFont: "Comic Sans", headingFont: 3 })).toEqual(
      DEFAULT_THEME_STYLES,
    );
    expect(
      readThemeStyles(
        JSON.stringify({ mainColor: "#2A6F4F", bodyFont: "system-serif", headingFont: "x" }),
      ),
    ).toEqual({
      mainColor: "#2a6f4f",
      logoMediaId: null,
      customCss: "",
      customCssOn: true,
      bodyFont: "system-serif",
      headingFont: "system-sans",
      colorMode: "system",
      modeSwitch: true,
    });
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the owner's look`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;

    beforeEach(async () => {
      db = await open();
      const result = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const id = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [id, name, email, T, T],
          );
          return { userId: id };
        },
        {
          siteName: "Anna's Garden",
          tagline: "Plants and pots",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = result.siteId;
      admin = actorOf(result.userId, "administrator");
      editor = actorOf(result.userId, "editor");
    });
    afterEach(async () => {
      await db.close();
    });

    test("a new site has the built-in look and writes no CSS", async () => {
      expect(await loadThemeStyles(db.runner, siteId)).toEqual(DEFAULT_THEME_STYLES);
      expect(await loadThemeCss(db.runner, siteId)).toBe(NEW_SITE_CSS);
    });

    test("saving a color and fonts changes the CSS; the parts not given stay", async () => {
      expect(
        await saveThemeStyles(db.runner, admin, siteId, {
          mainColor: "#2A6F4F",
          bodyFont: "system-serif",
        }),
      ).toEqual({
        ok: true,
        styles: {
          mainColor: "#2a6f4f",
          logoMediaId: null,
          customCss: "",
          customCssOn: true,
          bodyFont: "system-serif",
          headingFont: "system-sans",
          colorMode: "system",
          modeSwitch: true,
        },
      });
      await saveThemeStyles(db.runner, admin, siteId, { headingFont: "system-mono" });
      expect(await loadThemeStyles(db.runner, siteId)).toEqual({
        mainColor: "#2a6f4f",
        logoMediaId: null,
        customCss: "",
        customCssOn: true,
        bodyFont: "system-serif",
        headingFont: "system-mono",
        colorMode: "system",
        modeSwitch: true,
      });
      const css = await loadThemeCss(db.runner, siteId);
      expect(css).toContain("--oks-color-primary-700:");
      expect(css).toContain("--oks-site-font-heading:");
    });

    test("clearing the color brings the built-in look back", async () => {
      await saveThemeStyles(db.runner, admin, siteId, { mainColor: "#2a6f4f" });
      await saveThemeStyles(db.runner, admin, siteId, { mainColor: null });
      expect(await loadThemeCss(db.runner, siteId)).toBe(NEW_SITE_CSS);
    });

    test("refuses what is not a six-digit color or a listed font, and keeps what was saved", async () => {
      await saveThemeStyles(db.runner, admin, siteId, { mainColor: "#2a6f4f" });
      for (const input of [
        { mainColor: "green" },
        { mainColor: "#12345" },
        { mainColor: "red;}body{display:none" },
        { mainColor: "</style><script>x</script>" },
        { mainColor: 42 as unknown as string },
        { bodyFont: "Comic Sans" },
        { headingFont: 'x"; } body { display: none' },
        { logoMediaId: "no-such-picture" },
        { logoMediaId: 5 as unknown as string },
      ]) {
        const result = await saveThemeStyles(db.runner, admin, siteId, input);
        expect(result, JSON.stringify(input)).toMatchObject({ ok: false, code: "invalid" });
      }
      expect((await loadThemeStyles(db.runner, siteId)).mainColor).toBe("#2a6f4f");
    });

    test("a font of the library is saved and written with its rules; a name that only looks like one is refused", async () => {
      expect(
        await saveThemeStyles(db.runner, admin, siteId, {
          bodyFont: "inter",
          headingFont: "source-serif-4",
        }),
      ).toMatchObject({ ok: true, styles: { bodyFont: "inter", headingFont: "source-serif-4" } });
      const css = await loadThemeCss(db.runner, siteId);
      expect(css).toContain("@font-face");
      expect(css).toContain("/fonts/inter-latin-400.");
      for (const bodyFont of ["Inter", "inter ", "nothing", "inter-latin-400"])
        expect(
          await saveThemeStyles(db.runner, admin, siteId, { bodyFont }),
          bodyFont,
        ).toMatchObject({ ok: false, code: "invalid" });
      expect((await loadThemeStyles(db.runner, siteId)).bodyFont).toBe("inter");
    });

    test("light and dark: the mode and the visitors' switch are saved, written as CSS, and checked", async () => {
      expect((await loadThemeStyles(db.runner, siteId)).colorMode).toBe("system");
      expect(
        await saveThemeStyles(db.runner, admin, siteId, { colorMode: "system", modeSwitch: true }),
      ).toMatchObject({ ok: true, styles: { colorMode: "system", modeSwitch: true } });
      expect(await loadThemeCss(db.runner, siteId)).toContain(':root[data-theme="dark"]');
      for (const input of [
        { colorMode: "auto" },
        { colorMode: 1 as unknown as string },
        { modeSwitch: "yes" as unknown as boolean },
      ])
        expect(await saveThemeStyles(db.runner, admin, siteId, input)).toMatchObject({
          ok: false,
          code: "invalid",
        });
      expect(await loadThemeStyles(db.runner, siteId)).toMatchObject({
        colorMode: "system",
        modeSwitch: true,
      });
      // Back to the built-in look: no CSS at all.
      await saveThemeStyles(db.runner, admin, siteId, { colorMode: "light", modeSwitch: false });
      expect(await loadThemeCss(db.runner, siteId)).toBe("");
    });

    test("custom CSS is checked, kept without its comments, written after the look, and cleared with an empty text", async () => {
      const saved = await saveThemeStyles(db.runner, admin, siteId, {
        mainColor: "#2a6f4f",
        customCss: "/* mine */ h1 { letter-spacing: .1em }",
      });
      expect(saved).toMatchObject({
        ok: true,
        styles: { customCss: "h1 { letter-spacing: .1em }" },
      });
      const css = await loadThemeCss(db.runner, siteId);
      expect(css.indexOf("--oks-color-primary-700")).toBeLessThan(css.indexOf("letter-spacing"));
      await saveThemeStyles(db.runner, admin, siteId, { customCss: "" });
      expect(await loadThemeCss(db.runner, siteId)).not.toContain("letter-spacing");
    });

    test("custom CSS that fails the check is refused with the line, and what was saved stays", async () => {
      await saveThemeStyles(db.runner, admin, siteId, { customCss: "h1{color:red}" });
      for (const customCss of [
        "@import 'x.css';",
        "a{background:url(https://evil.example/x)}",
        "a{color:red}</style><script>x</script>",
        "a{color:red",
        "a{color:red}".repeat(6000),
        5 as unknown as string,
      ]) {
        const result = await saveThemeStyles(db.runner, admin, siteId, { customCss });
        expect(result, String(customCss).slice(0, 40)).toMatchObject({
          ok: false,
          code: "invalid",
          field: "customCss",
        });
      }
      const refused = await saveThemeStyles(db.runner, admin, siteId, {
        customCss: "a{}\nb{}\n@import 'x';",
      });
      expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("Line 3") });
      expect((await loadThemeStyles(db.runner, siteId)).customCss).toBe("h1{color:red}");
    });

    test("stored custom CSS that is not safe is never written", async () => {
      const bad = JSON.stringify({ customCss: "@import 'x.css'; a{}</style>" });
      await db.run(
        `insert into settings (site_id, key, value, revision, updated_at) values (?, 'theme', ?, 1, ?)`,
        [siteId, bad, new Date()],
      );
      expect((await loadThemeStyles(db.runner, siteId)).customCss).toBe("");
      expect(await loadThemeCss(db.runner, siteId)).toBe(NEW_SITE_CSS);
    });

    test("only people who manage the settings may change it", async () => {
      expect(
        await saveThemeStyles(db.runner, editor, siteId, { mainColor: "#2a6f4f" }),
      ).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await loadThemeCss(db.runner, siteId)).toBe(NEW_SITE_CSS);
    });
  });
}
