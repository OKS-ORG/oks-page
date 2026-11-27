// How the admin looks for one person (docs/18-new-look.md, step 7): the choices are kept per person, only what was chosen is kept,
// a bad choice is refused in plain words, and the rules that show a choice are readable in every look and mode.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  accentAdjusted,
  appearanceCss,
  coloursFor,
  DEFAULT_APPEARANCE,
  loadAppearance,
  needsAppearanceCss,
  readAppearance,
  resetAppearance,
  saveAppearance,
} from "./appearance.js";
import { contrast, parseColour } from "./accent.js";
import { LOOK_KEYS } from "./looks.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);

describe("reading what is stored", () => {
  test("anything that is not understood is simply not there, and the default fills the rest", () => {
    expect(readAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance("{broken")).toEqual(DEFAULT_APPEARANCE);
    expect(
      readAppearance({ look: "neon", mode: "dim", accent: "red", menuCollapsed: "yes" }),
    ).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance(JSON.stringify({ look: "pine", accent: "#1A5FB4" }))).toEqual({
      ...DEFAULT_APPEARANCE,
      look: "pine",
      accent: "#1a5fb4",
    });
  });

  test("the site's default shows for what the person never chose, and the person's own choice wins", () => {
    const site = { ...DEFAULT_APPEARANCE, look: "ember" as const, mode: "dark" as const };
    expect(readAppearance({ mode: "light" }, site)).toEqual({ ...site, mode: "light" });
    expect(readAppearance(null, site)).toEqual(site);
  });
});

describe("showing a choice", () => {
  test("the product's own choice needs no extra rules; anything else does", () => {
    expect(needsAppearanceCss(DEFAULT_APPEARANCE)).toBe(false);
    expect(needsAppearanceCss({ ...DEFAULT_APPEARANCE, mode: "dark" })).toBe(true);
    expect(needsAppearanceCss({ ...DEFAULT_APPEARANCE, accent: "#1a5fb4" })).toBe(true);
    expect(needsAppearanceCss({ ...DEFAULT_APPEARANCE, look: "pine" })).toBe(true);
  });

  test("light and dark are forced, and the device decides only for the match-my-device choice", () => {
    const light = appearanceCss({ ...DEFAULT_APPEARANCE, mode: "light" });
    expect(light).toContain("--adm-ground:#f6f8fc");
    expect(light).not.toContain("prefers-color-scheme");
    const dark = appearanceCss({ ...DEFAULT_APPEARANCE, mode: "dark" });
    expect(dark).toContain("--adm-ground:#131314");
    expect(dark).not.toContain("prefers-color-scheme");
    const system = appearanceCss({ ...DEFAULT_APPEARANCE, mode: "system" });
    expect(system).toContain("--adm-ground:#f6f8fc");
    expect(system).toContain("@media (prefers-color-scheme: dark)");
  });

  test("a colour of the person's own reads in every look and mode: the label on it and the text it makes", () => {
    for (const accent of ["#1a5fb4", "#ffe066", "#222222", "#ff6b57", "#0b57d0"])
      for (const look of LOOK_KEYS)
        for (const mode of ["light", "dark"] as const) {
          const { colours: c } = coloursFor(look, mode, accent);
          const rgb = (hex: string) => parseColour(hex)!;
          expect(
            contrast(rgb(c.on), rgb(c.accent)),
            `${accent} ${look} ${mode} label`,
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            contrast(rgb(c.selText), rgb(c.sel)),
            `${accent} ${look} ${mode} on pale`,
          ).toBeGreaterThanOrEqual(4.5);
        }
  });

  test("a colour that is too pale is darkened, and the screen can say so", () => {
    expect(accentAdjusted("clear-sky", "#ffe066")).toBe(true);
    expect(accentAdjusted("clear-sky", "")).toBe(false);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: keeping a person's choices`, () => {
    let db: TestDb;
    let siteId = "";
    let userId = "";
    let otherId = "";

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
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
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      userId = setup.userId;
      otherId = newId();
    });
    afterEach(async () => db.close());

    test("nothing is stored until the person chooses, and a choice is kept for that person only", async () => {
      expect(await loadAppearance(db.runner, siteId, userId)).toEqual(DEFAULT_APPEARANCE);
      const saved = await saveAppearance(db.runner, siteId, userId, { look: "pine", mode: "dark" });
      expect(saved).toEqual({
        ok: true,
        appearance: { ...DEFAULT_APPEARANCE, look: "pine", mode: "dark" },
      });
      expect(await loadAppearance(db.runner, siteId, userId)).toEqual({
        ...DEFAULT_APPEARANCE,
        look: "pine",
        mode: "dark",
      });
      expect(await loadAppearance(db.runner, siteId, otherId)).toEqual(DEFAULT_APPEARANCE);
    });

    test("a change keeps the rest, and an empty accent goes back to the look's own colour", async () => {
      await saveAppearance(db.runner, siteId, userId, { look: "ember", accent: "#1a5fb4" });
      await saveAppearance(db.runner, siteId, userId, { menuCollapsed: true });
      expect(await loadAppearance(db.runner, siteId, userId)).toEqual({
        look: "ember",
        mode: "system",
        accent: "#1a5fb4",
        menuCollapsed: true,
      });
      await saveAppearance(db.runner, siteId, userId, { accent: "" });
      expect((await loadAppearance(db.runner, siteId, userId)).accent).toBe("");
    });

    test("only what the person chose is kept, so a later site default still reaches the rest", async () => {
      const site = { ...DEFAULT_APPEARANCE, look: "pine" as const };
      await saveAppearance(db.runner, siteId, userId, { mode: "dark" }, site);
      expect(await loadAppearance(db.runner, siteId, userId, site)).toMatchObject({
        look: "pine",
        mode: "dark",
      });
      const later = { ...DEFAULT_APPEARANCE, look: "ember" as const };
      expect(await loadAppearance(db.runner, siteId, userId, later)).toMatchObject({
        look: "ember",
        mode: "dark",
      });
    });

    test("a bad choice is refused in plain words and nothing changes", async () => {
      for (const [input, field] of [
        [{ look: "neon" }, "look"],
        [{ mode: "dim" }, "mode"],
        [{ accent: "blue" }, "accent"],
        [{ accent: 5 }, "accent"],
        [{ menuCollapsed: "yes" }, "menuCollapsed"],
        [{ colour: "#fff" }, "colour"],
      ] as const) {
        const r = await saveAppearance(db.runner, siteId, userId, input);
        expect(r.ok, JSON.stringify(input)).toBe(false);
        if (!r.ok) expect(r.field).toBe(field);
      }
      expect((await saveAppearance(db.runner, siteId, userId, [])).ok).toBe(false);
      expect(await loadAppearance(db.runner, siteId, userId)).toEqual(DEFAULT_APPEARANCE);
    });

    test("reset takes the person's choices away", async () => {
      await saveAppearance(db.runner, siteId, userId, { look: "pine" });
      await resetAppearance(db.runner, siteId, userId);
      expect(await loadAppearance(db.runner, siteId, userId)).toEqual(DEFAULT_APPEARANCE);
    });
  });
}
