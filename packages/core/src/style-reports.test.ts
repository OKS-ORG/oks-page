import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import { saveSecuritySettings } from "./security.js";
import {
  dismissBlockedStyle,
  listBlockedStyles,
  MAX_BLOCKED_STYLES,
  recordBlockedStyle,
  styleReportFrom,
} from "./style-reports.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

describe("reports about refused stylesheets", () => {
  const legacy = (over: Record<string, unknown> = {}) => ({
    "csp-report": {
      "document-uri": "https://garden.example/about?x=1",
      "effective-directive": "style-src-elem",
      "blocked-uri": "https://cdn.example.net/site.css",
      ...over,
    },
  });

  test("a refused stylesheet from an https host is understood, in both report shapes", () => {
    expect(styleReportFrom(legacy())).toEqual({ host: "cdn.example.net", page: "/about" });
    expect(
      styleReportFrom([
        {
          type: "csp-violation",
          body: {
            effectiveDirective: "style-src-elem",
            blockedURL: "https://Assets.Example.com/a.css",
            documentURL: "https://garden.example/",
          },
        },
      ]),
    ).toEqual({ host: "assets.example.com", page: "/" });
  });

  test("anything else is ignored: other rules, inline, http, numbers, the site's own host, damaged reports", () => {
    expect(styleReportFrom(legacy({ "effective-directive": "script-src-elem" }))).toBeNull();
    expect(styleReportFrom(legacy({ "blocked-uri": "inline" }))).toBeNull();
    expect(styleReportFrom(legacy({ "blocked-uri": "http://cdn.example.net/a.css" }))).toBeNull();
    expect(styleReportFrom(legacy({ "blocked-uri": "https://203.0.113.5/a.css" }))).toBeNull();
    expect(styleReportFrom(legacy({ "blocked-uri": "chrome-extension://abc/x.css" }))).toBeNull();
    expect(styleReportFrom(legacy({ "blocked-uri": "https://garden.example/own.css" }))).toBeNull();
    expect(styleReportFrom("text")).toBeNull();
    expect(styleReportFrom(null)).toBeNull();
    expect(styleReportFrom({ "csp-report": 5 })).toBeNull();
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: blocked stylesheets`, () => {
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
      editor = actorOf("someone", "editor");
    });
    afterEach(async () => db.close());

    const report = (host: string, page = "/") => ({ host, page });

    test("a host is kept with a count; a host that is allowed is not kept; allowing it clears it from the list", async () => {
      expect(await listBlockedStyles(db.runner, siteId)).toEqual([]);
      const now = () => T.getTime();
      await recordBlockedStyle(db.runner, siteId, report("cdn.example.net", "/about"), now);
      await recordBlockedStyle(
        db.runner,
        siteId,
        report("cdn.example.net", "/team"),
        () => now() + 1000,
      );
      await recordBlockedStyle(db.runner, siteId, report("fonts.example.org"), () => now() + 2000);
      const list = await listBlockedStyles(db.runner, siteId);
      expect(list.map((b) => [b.host, b.count, b.page])).toEqual([
        ["fonts.example.org", 1, "/"],
        ["cdn.example.net", 2, "/team"],
      ]);
      // The owner allows one: it leaves the list, and a later report about it is not kept.
      const saved = await saveSecuritySettings(db.runner, admin, siteId, {
        styleHosts: ["cdn.example.net"],
      });
      expect(saved.ok).toBe(true);
      expect((await listBlockedStyles(db.runner, siteId)).map((b) => b.host)).toEqual([
        "fonts.example.org",
      ]);
      expect(await recordBlockedStyle(db.runner, siteId, report("cdn.example.net"), now)).toBe(
        false,
      );
    });

    test("only the newest hosts are kept, and only a person who manages the settings can dismiss one", async () => {
      for (let i = 0; i < MAX_BLOCKED_STYLES + 5; i += 1)
        await recordBlockedStyle(
          db.runner,
          siteId,
          report(`h${i}.example.net`),
          () => T.getTime() + i,
        );
      const list = await listBlockedStyles(db.runner, siteId);
      expect(list).toHaveLength(MAX_BLOCKED_STYLES);
      expect(list[0]!.host).toBe(`h${MAX_BLOCKED_STYLES + 4}.example.net`);
      expect(await dismissBlockedStyle(db.runner, editor, siteId, list[0]!.host)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await dismissBlockedStyle(db.runner, admin, siteId, "*.example.net")).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await dismissBlockedStyle(db.runner, admin, siteId, list[0]!.host)).toEqual({
        ok: true,
      });
      expect(await listBlockedStyles(db.runner, siteId)).toHaveLength(MAX_BLOCKED_STYLES - 1);
    });
  });
}
