import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  PREVIEW_DEFAULT_DAYS,
  PREVIEW_MAX_DAYS,
  checkPreviewToken,
  loadPreviewEntry,
  makePreviewToken,
  previewExpiry,
} from "./preview.js";
import { runSetup } from "./setup.js";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("the signed link (spec 03, Preview)", () => {
  const id = "ENT00000000000000000000001";

  test("a token made for an entry is accepted until its time, and not after", () => {
    const token = makePreviewToken(SECRET, id, NOW + 7 * DAY);
    expect(checkPreviewToken(SECRET, id, token, NOW)).toBe(true);
    expect(checkPreviewToken(SECRET, id, token, NOW + 7 * DAY - 1)).toBe(true);
    expect(checkPreviewToken(SECRET, id, token, NOW + 7 * DAY)).toBe(false);
    expect(checkPreviewToken(SECRET, id, token, NOW + 8 * DAY)).toBe(false);
  });

  test("it cannot be moved to another entry, changed, or made with another secret", () => {
    const token = makePreviewToken(SECRET, id, NOW + 7 * DAY);
    expect(checkPreviewToken(SECRET, "ENT00000000000000000000002", token, NOW)).toBe(false);
    expect(checkPreviewToken("t".repeat(40), id, token, NOW)).toBe(false);
    const [expires, signature] = token.split(".");
    // A longer life with the old signature, and a changed signature.
    expect(checkPreviewToken(SECRET, id, `${Number(expires) + DAY}.${signature}`, NOW)).toBe(false);
    const flipped = signature!.slice(0, -1) + (signature!.endsWith("A") ? "B" : "A");
    expect(checkPreviewToken(SECRET, id, `${expires}.${flipped}`, NOW)).toBe(false);
  });

  test("broken or missing tokens are refused", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "x",
      ".",
      "123.",
      `.${"a".repeat(43)}`,
      `abc.${"a".repeat(43)}`,
      `${NOW + DAY}.${"a".repeat(42)}`,
      `${NOW + DAY}.${"a".repeat(44)}`,
      `${NOW + DAY}.${"!".repeat(43)}`,
      `-5.${"a".repeat(43)}`,
      `1e12.${"a".repeat(43)}`,
    ])
      expect(checkPreviewToken(SECRET, id, bad, NOW), String(bad)).toBe(false);
    expect(checkPreviewToken("", id, makePreviewToken("", id, NOW + DAY), NOW)).toBe(false);
  });

  test("a token that lives longer than the longest link we make is refused, so a leaked secret cannot make endless links", () => {
    const forever = makePreviewToken(SECRET, id, NOW + (PREVIEW_MAX_DAYS + 1) * DAY);
    expect(checkPreviewToken(SECRET, id, forever, NOW)).toBe(false);
    const longest = makePreviewToken(SECRET, id, NOW + PREVIEW_MAX_DAYS * DAY);
    expect(checkPreviewToken(SECRET, id, longest, NOW)).toBe(true);
  });

  test("the expiry is a whole number of days from now: 1 to 30, 7 by default", () => {
    expect(previewExpiry(NOW)).toBe(NOW + PREVIEW_DEFAULT_DAYS * DAY);
    expect(previewExpiry(NOW, 1)).toBe(NOW + DAY);
    expect(previewExpiry(NOW, 30)).toBe(NOW + 30 * DAY);
    for (const bad of [0, 31, -1, 1.5, Number.NaN, Infinity])
      expect(previewExpiry(NOW, bad), String(bad)).toBeNull();
  });
});

const T = new Date(1_700_000_000_000);
for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: what a preview shows`, () => {
    let db: TestDb;
    let siteId = "";
    let userId = "";

    const add = async (title: string, status: string) => {
      const id = newId();
      await db.run(
        `insert into entries (id, site_id, type_key, status, title, slug, author_id, fields, body, plain_text, html, seo, meta, created_at, updated_at)
         values (?, ?, 'post', ?, ?, ?, ?, '{}', '{"version":1,"blocks":[]}', '', ?, '{}', '{}', ?, ?)`,
        [id, siteId, status, title, `blog/${id}`, userId, `<p>${title} body</p>`, T, T],
      );
      return id;
    };

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
          siteName: "S",
          admin: { name: "Anna", email: "anna@example.com", password: "a-long-password" },
        },
      );
      siteId = setup.siteId;
      userId = setup.userId;
    });
    afterEach(async () => {
      await db.close();
    });

    test("the saved version of a draft, scheduled, private or published entry; not the trash, not another site", async () => {
      for (const status of ["draft", "scheduled", "private", "published"]) {
        const id = await add(`Entry ${status}`, status);
        expect(await loadPreviewEntry(db.runner, siteId, id), status).toMatchObject({
          id,
          title: `Entry ${status}`,
          status,
          type: "post",
          html: `<p>Entry ${status} body</p>`,
        });
      }
      const trashed = await add("Gone", "trash");
      expect(await loadPreviewEntry(db.runner, siteId, trashed)).toBeNull();
      const other = await add("Other", "draft");
      expect(await loadPreviewEntry(db.runner, newId(), other)).toBeNull();
      expect(await loadPreviewEntry(db.runner, siteId, newId())).toBeNull();
    });
  });
}
