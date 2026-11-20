// The places the owner publishes to (spec 10, section 7.2): kept per site, checked, and with the result of the last publish.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "./content.js";
import {
  cleanTargetPath,
  deletePublishTarget,
  listPublishTargets,
  loadPublishLast,
  readTargets,
  recordPublishLast,
  savePublishTarget,
} from "./publish-targets.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);

describe("the path of a place", () => {
  test("a folder needs a whole path, a zip file a plain name", () => {
    expect(cleanTargetPath("folder", " /var/www/site ")).toEqual({ path: "/var/www/site" });
    expect(cleanTargetPath("folder", "C:\\sites\\client")).toEqual({ path: "C:\\sites\\client" });
    for (const bad of [
      "",
      "site",
      "./site",
      "/",
      "//share/x",
      "/var/../etc",
      "C:\\a\\..\\b",
      "/a\0b",
    ])
      expect(cleanTargetPath("folder", bad), bad).toHaveProperty("problem");
    expect(cleanTargetPath("zip", "site.zip")).toEqual({ path: "site.zip" });
    for (const bad of [
      "site",
      "../site.zip",
      "a/b.zip",
      "/tmp/x.zip",
      ".zip",
      "x".repeat(200) + ".zip",
    ])
      expect(cleanTargetPath("zip", bad), bad).toHaveProperty("problem");
  });

  test("a damaged saved list gives only the places that are whole", () => {
    expect(readTargets("not json")).toEqual([]);
    expect(
      readTargets([
        { id: "a", kind: "folder", label: "A", path: "/x" },
        { id: "b", kind: "ftp", label: "B", path: "/x" },
        { id: 3, kind: "zip", label: "C", path: "c.zip" },
        null,
      ]),
    ).toEqual([{ id: "a", kind: "folder", label: "A", path: "/x" }]);
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: places to publish to`, () => {
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
      const as = (role: string): Actor => {
        const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
        return { userId: setup.userId, can: (c) => caps.includes(c) };
      };
      admin = as("administrator");
      editor = as("editor");
    });
    afterEach(async () => {
      await db.close();
    });

    test("a place is added, changed and removed, and only by someone who changes the settings", async () => {
      expect(await listPublishTargets(db.runner, siteId)).toEqual([]);
      expect(
        await savePublishTarget(db.runner, editor, siteId, {
          kind: "folder",
          label: "X",
          path: "/x",
        }),
      ).toMatchObject({ ok: false, code: "forbidden" });
      const added = await savePublishTarget(db.runner, admin, siteId, {
        kind: "folder",
        label: "Client server",
        path: "/var/www/client",
      });
      expect(added.ok && added.target).toMatchObject({ kind: "folder", label: "Client server" });
      if (!added.ok) return;
      const zip = await savePublishTarget(db.runner, admin, siteId, {
        kind: "zip",
        label: "Download",
        path: "site.zip",
      });
      expect(zip.ok).toBe(true);
      expect((await listPublishTargets(db.runner, siteId)).map((t) => t.label)).toEqual([
        "Client server",
        "Download",
      ]);
      // Changing keeps the id and the place in the list.
      const changed = await savePublishTarget(db.runner, admin, siteId, {
        id: added.target.id,
        kind: "folder",
        label: "Client server (new)",
        path: "/var/www/new",
      });
      expect(changed.ok && changed.target.id).toBe(added.target.id);
      expect((await listPublishTargets(db.runner, siteId))[0]).toMatchObject({
        label: "Client server (new)",
        path: "/var/www/new",
      });
      expect(
        await savePublishTarget(db.runner, admin, siteId, {
          id: "nothing",
          kind: "folder",
          label: "X",
          path: "/x",
        }),
      ).toMatchObject({ ok: false, code: "not_found" });
      expect(await deletePublishTarget(db.runner, editor, siteId, added.target.id)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await deletePublishTarget(db.runner, admin, siteId, added.target.id)).toEqual({
        ok: true,
      });
      expect((await listPublishTargets(db.runner, siteId)).map((t) => t.label)).toEqual([
        "Download",
      ]);
      expect(await deletePublishTarget(db.runner, admin, siteId, added.target.id)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });

    test("a bad kind, name or path is refused in plain words, and there are at most ten places", async () => {
      const bad = (over: object) =>
        savePublishTarget(db.runner, admin, siteId, {
          kind: "folder",
          label: "X",
          path: "/x",
          ...over,
        });
      expect(await bad({ kind: "ftp" })).toMatchObject({ ok: false, code: "invalid" });
      expect(await bad({ label: " " })).toMatchObject({ ok: false, code: "invalid" });
      expect(await bad({ label: "x".repeat(61) })).toMatchObject({ ok: false });
      expect(await bad({ path: "relative" })).toMatchObject({ ok: false });
      for (let i = 0; i < 10; i++) expect((await bad({ label: `P${i}` })).ok).toBe(true);
      expect(await bad({ label: "one more" })).toMatchObject({
        ok: false,
        message: "A site can have at most 10 places to publish to.",
      });
    });

    test("the result of the last publish is kept for each place and goes with the place", async () => {
      const a = await savePublishTarget(db.runner, admin, siteId, {
        kind: "zip",
        label: "A",
        path: "a.zip",
      });
      if (!a.ok) throw new Error("no place");
      expect(await loadPublishLast(db.runner, siteId)).toEqual({});
      await recordPublishLast(db.runner, siteId, a.target.id, {
        at: 1_700_000_000_000,
        ok: true,
        message: "Published: 2 files sent, 0 removed.",
      });
      await recordPublishLast(db.runner, siteId, "other", {
        at: 5,
        ok: false,
        message: "x".repeat(900),
      });
      const last = await loadPublishLast(db.runner, siteId);
      expect(last[a.target.id]).toEqual({
        at: 1_700_000_000_000,
        ok: true,
        message: "Published: 2 files sent, 0 removed.",
      });
      expect(last["other"]!.message).toHaveLength(500);
      await deletePublishTarget(db.runner, admin, siteId, a.target.id);
      expect(Object.keys(await loadPublishLast(db.runner, siteId))).toEqual(["other"]);
    });
  });
}
