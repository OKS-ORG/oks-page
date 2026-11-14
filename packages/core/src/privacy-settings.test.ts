import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, type Actor } from "./content.js";
import {
  SITE_COOKIES,
  consentNeeded,
  listPrivacyPageChoices,
  loadPrivacySettings,
  noVisitorCookies,
  privacyDraftBlocks,
  savePrivacyPage,
  writePrivacyDraft,
} from "./privacy-settings.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};
const words = (blocks: unknown[]) => JSON.stringify(blocks);

describe("privacy facts", () => {
  test("PR-01: a new site sets no cookie for visitors and needs no consent notice", () => {
    expect(SITE_COOKIES.map((c) => c.name)).toEqual(["Sign-in cookie"]);
    expect(noVisitorCookies()).toBe(true);
    expect(consentNeeded()).toBe(false);
    const tracker = {
      name: "Statistics",
      purpose: "Counts visits.",
      who: "visitors" as const,
      needed: false,
    };
    expect(consentNeeded([...SITE_COOKIES, tracker])).toBe(true);
    expect(noVisitorCookies([...SITE_COOKIES, tracker])).toBe(false);
  });

  test("the draft says what the site really uses; the email part only when email is set up", () => {
    const without = words(privacyDraftBlocks({ siteName: "Anna's Garden", emailProvider: null }));
    expect(without).toContain("Anna's Garden");
    expect(without).toContain("Visitors get no cookies");
    expect(without).not.toContain("email service");
    const withEmail = words(
      privacyDraftBlocks({ siteName: "Anna's Garden", emailProvider: "Brevo" }),
    );
    expect(withEmail).toContain("the email service Brevo");
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: the privacy page`, () => {
    let db: TestDb;
    let siteId = "";
    let admin: Actor;
    let editor: Actor;

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
      admin = actorOf(setup.userId, "administrator");
      editor = actorOf(setup.userId, "editor");
    });
    afterEach(async () => db.close());

    test("choosing a page: only pages of the site, only people who manage the settings; none again", async () => {
      expect(await loadPrivacySettings(db.runner, siteId)).toEqual({ pageId: null });
      const page = await createDraft(db.runner, admin, siteId, { type: "page", title: "About us" });
      const post = await createDraft(db.runner, admin, siteId, { type: "post", title: "A post" });
      if (!page.ok || !post.ok) throw new Error("no drafts");
      expect((await listPrivacyPageChoices(db.runner, siteId)).map((p) => p.title)).toContain(
        "About us",
      );
      expect(await savePrivacyPage(db.runner, editor, siteId, page.id)).toMatchObject({
        code: "forbidden",
      });
      expect(await savePrivacyPage(db.runner, admin, siteId, post.id)).toMatchObject({
        code: "invalid",
      });
      expect(await savePrivacyPage(db.runner, admin, siteId, "not-an-id")).toMatchObject({
        code: "invalid",
      });
      expect(await savePrivacyPage(db.runner, admin, siteId, page.id)).toMatchObject({ ok: true });
      expect(await loadPrivacySettings(db.runner, siteId)).toEqual({ pageId: page.id });
      expect(await savePrivacyPage(db.runner, admin, siteId, null)).toMatchObject({ ok: true });
      expect(await loadPrivacySettings(db.runner, siteId)).toEqual({ pageId: null });
    });

    test("Write a draft for me: a draft page, not published, that becomes the privacy page", async () => {
      expect(
        await writePrivacyDraft(db.runner, editor, siteId, {
          siteName: "Anna's Garden",
          emailProvider: null,
        }),
      ).toMatchObject({ code: "forbidden" });
      const made = await writePrivacyDraft(db.runner, admin, siteId, {
        siteName: "Anna's Garden",
        emailProvider: "Brevo",
      });
      if (!made.ok) throw new Error(made.message);
      expect(await loadPrivacySettings(db.runner, siteId)).toEqual({ pageId: made.id });
      const rows = await db.runner.all(
        `select "type_key", "status", "title" from "entries" where "id" = ?`,
        [made.id],
      );
      expect(rows[0]).toMatchObject({ type_key: "page", status: "draft", title: "Privacy" });
      // A second draft does not overwrite the first page.
      const again = await writePrivacyDraft(db.runner, admin, siteId, {
        siteName: "x",
        emailProvider: null,
      });
      if (!again.ok) throw new Error(again.message);
      expect(again.id).not.toBe(made.id);
      expect(again.slug).not.toBe(made.slug);
    });
  });
}
