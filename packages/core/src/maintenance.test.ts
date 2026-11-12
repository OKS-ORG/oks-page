import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  DEFAULT_MAINTENANCE_MESSAGE,
  MAINTENANCE_MESSAGE_MAX,
  loadMaintenanceSettings,
  readMaintenanceSettings,
  saveMaintenanceSettings,
} from "./maintenance.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("reading a saved value", () => {
  test("it is on only when it says so; the message falls back to the default", () => {
    expect(readMaintenanceSettings(undefined)).toEqual({
      enabled: false,
      message: DEFAULT_MAINTENANCE_MESSAGE,
    });
    expect(readMaintenanceSettings({ enabled: true, message: " Back at 5. " })).toEqual({
      enabled: true,
      message: "Back at 5.",
    });
    expect(readMaintenanceSettings(JSON.stringify({ enabled: true, message: "x" }))).toEqual({
      enabled: true,
      message: "x",
    });
  });
  test("damaged values mean off with the default message", () => {
    for (const bad of ["not json", null, 5, [], { enabled: "yes", message: 7 }, { enabled: 1 }])
      expect(readMaintenanceSettings(bad)).toEqual({
        enabled: false,
        message: DEFAULT_MAINTENANCE_MESSAGE,
      });
    expect(
      readMaintenanceSettings({ enabled: true, message: "x".repeat(MAINTENANCE_MESSAGE_MAX + 1) }),
    ).toEqual({ enabled: true, message: DEFAULT_MAINTENANCE_MESSAGE });
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: maintenance mode`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;

    beforeEach(async () => {
      db = await open();
      const setup = await runSetup(
        db.runner,
        async ({ name, email }) => {
          const userId = newId();
          await db.run(
            "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
            [userId, name, email, T, T],
          );
          return { userId };
        },
        {
          siteName: "S",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      admin = actorOf(setup.userId, "administrator");
      editor = actorOf(setup.userId, "editor");
    });
    afterEach(async () => {
      await db.close();
    });

    test("off at first, with the default message", async () => {
      expect(await loadMaintenanceSettings(db.runner, siteId)).toEqual({
        enabled: false,
        message: DEFAULT_MAINTENANCE_MESSAGE,
      });
    });

    test("turning it on and changing the message, saved in one row that counts its revisions", async () => {
      expect(
        await saveMaintenanceSettings(db.runner, admin, siteId, {
          enabled: true,
          message: "  Back at five.  ",
        }),
      ).toMatchObject({ ok: true, settings: { enabled: true, message: "Back at five." } });
      expect(await loadMaintenanceSettings(db.runner, siteId)).toEqual({
        enabled: true,
        message: "Back at five.",
      });
      // Only the switch: the message stays.
      await saveMaintenanceSettings(db.runner, admin, siteId, { enabled: false });
      expect(await loadMaintenanceSettings(db.runner, siteId)).toEqual({
        enabled: false,
        message: "Back at five.",
      });
      const rows = await db.run("select revision from settings where key = 'maintenance'");
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!["revision"])).toBe(2);
    });

    test("an empty message becomes the default", async () => {
      await saveMaintenanceSettings(db.runner, admin, siteId, { enabled: true, message: "   " });
      expect((await loadMaintenanceSettings(db.runner, siteId)).message).toBe(
        DEFAULT_MAINTENANCE_MESSAGE,
      );
    });

    test("only people who manage the settings, and only sensible values", async () => {
      expect(
        await saveMaintenanceSettings(db.runner, editor, siteId, { enabled: true }),
      ).toMatchObject({ ok: false, code: "forbidden" });
      expect(
        await saveMaintenanceSettings(db.runner, admin, siteId, { enabled: "yes" as never }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect(
        await saveMaintenanceSettings(db.runner, admin, siteId, { message: 5 as never }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect(
        await saveMaintenanceSettings(db.runner, admin, siteId, {
          message: "x".repeat(MAINTENANCE_MESSAGE_MAX + 1),
        }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect(await db.run("select 1 from settings where key = 'maintenance'")).toHaveLength(0);
    });
  });
}
