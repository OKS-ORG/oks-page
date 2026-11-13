import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  SITE_NAME_MAX,
  TAGLINE_MAX,
  loadGeneralSettings,
  saveGeneralSettings,
} from "./general-settings.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the general settings`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;

    const setup = async (extra: { timeZone?: string } = {}) => {
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
          ...extra,
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = result.siteId;
      admin = actorOf(result.userId, "administrator");
      editor = actorOf(result.userId, "editor");
    };

    beforeEach(async () => {
      db = await open();
    });
    afterEach(async () => {
      await db.close();
    });

    test("what the wizard saved: the name, the tagline and no time zone (automatic) when none was sent", async () => {
      await setup();
      expect(await loadGeneralSettings(db.runner, siteId)).toEqual({
        siteName: "Anna's Garden",
        tagline: "Plants and pots",
        timeZone: null,
      });
    });

    test("the wizard keeps the browser's time zone, and leaves out one that is not real", async () => {
      await setup({ timeZone: "Asia/Kolkata" });
      expect((await loadGeneralSettings(db.runner, siteId)).timeZone).toBe("Asia/Kolkata");
      await db.close();
      db = await open();
      await setup({ timeZone: "Mars/Base" });
      expect((await loadGeneralSettings(db.runner, siteId)).timeZone).toBeNull();
    });

    test("saving changes the name (also where the dashboard reads it), the tagline and the time zone; the rest stays", async () => {
      await setup();
      expect(
        await saveGeneralSettings(db.runner, admin, siteId, {
          siteName: "  Anna’s Greenhouse  ",
          timeZone: "Asia/Kolkata",
        }),
      ).toMatchObject({
        ok: true,
        settings: {
          siteName: "Anna’s Greenhouse",
          tagline: "Plants and pots",
          timeZone: "Asia/Kolkata",
        },
      });
      const sites = await db.run("select name from sites");
      expect(sites[0]!["name"]).toBe("Anna’s Greenhouse");
      expect(await loadGeneralSettings(db.runner, siteId)).toEqual({
        siteName: "Anna’s Greenhouse",
        tagline: "Plants and pots",
        timeZone: "Asia/Kolkata",
      });
      await saveGeneralSettings(db.runner, admin, siteId, { tagline: "" });
      expect((await loadGeneralSettings(db.runner, siteId)).tagline).toBe("");
      // Back to automatic: the row goes, and there is still one row for each of the other settings.
      await saveGeneralSettings(db.runner, admin, siteId, { timeZone: null });
      expect((await loadGeneralSettings(db.runner, siteId)).timeZone).toBeNull();
      expect(await db.run("select 1 from settings where key = 'timezone'")).toHaveLength(0);
      expect(await db.run("select 1 from settings where key = 'title'")).toHaveLength(1);
      expect(await db.run("select 1 from settings where key = 'tagline'")).toHaveLength(1);
    });

    test("an empty time zone also means automatic", async () => {
      await setup({ timeZone: "Europe/Berlin" });
      await saveGeneralSettings(db.runner, admin, siteId, { timeZone: "" as never });
      expect((await loadGeneralSettings(db.runner, siteId)).timeZone).toBeNull();
    });

    test("refusals, each with the field and a plain message, and nothing is saved", async () => {
      await setup({ timeZone: "Europe/Berlin" });
      const before = await loadGeneralSettings(db.runner, siteId);
      const refuse = async (input: object, field: string) =>
        expect(await saveGeneralSettings(db.runner, admin, siteId, input as never)).toMatchObject({
          ok: false,
          code: "invalid",
          field,
        });
      await refuse({ siteName: "   " }, "siteName");
      await refuse({ siteName: "x".repeat(SITE_NAME_MAX + 1) }, "siteName");
      await refuse({ siteName: 5 }, "siteName");
      await refuse({ tagline: "x".repeat(TAGLINE_MAX + 1) }, "tagline");
      await refuse({ tagline: 5 }, "tagline");
      await refuse({ timeZone: "Mars/Base" }, "timeZone");
      await refuse({ timeZone: 5 }, "timeZone");
      // A name of exactly the longest length, in a script of two-code-unit letters, is counted by characters.
      expect(
        await saveGeneralSettings(db.runner, admin, siteId, {
          siteName: "𠮷".repeat(SITE_NAME_MAX),
        }),
      ).toMatchObject({ ok: true });
      await saveGeneralSettings(db.runner, admin, siteId, { siteName: before.siteName });
      expect(await loadGeneralSettings(db.runner, siteId)).toEqual(before);
    });

    test("only people who manage the settings", async () => {
      await setup();
      expect(
        await saveGeneralSettings(db.runner, editor, siteId, { siteName: "Mine" }),
      ).toMatchObject({ ok: false, code: "forbidden" });
      expect((await loadGeneralSettings(db.runner, siteId)).siteName).toBe("Anna's Garden");
    });

    test("a missing or damaged saved value falls back: the site name, an empty tagline, automatic", async () => {
      await setup();
      await db.run("delete from settings where key in ('title', 'tagline')");
      await db.run(
        "insert into settings (site_id, key, value, revision, updated_at) values (?, 'timezone', ?, 1, ?)",
        [siteId, JSON.stringify("Not/AZone"), T],
      );
      expect(await loadGeneralSettings(db.runner, siteId)).toEqual({
        siteName: "Anna's Garden",
        tagline: "",
        timeZone: null,
      });
    });
  });
}
