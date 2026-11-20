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
  publicTarget,
  readTargets,
  recordPublishLast,
  savePublishTarget,
  secretPlace,
} from "./publish-targets.js";
import { DEFAULT_ROLES } from "./roles.js";
import { SiteSecrets } from "./secret-box.js";
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

    test("an SFTP place keeps its secrets sealed, never shows them, keeps a saved one when it is left out, and needs what the sign-in needs", async () => {
      const box = new SiteSecrets("a-site-secret-that-is-long-enough-0123456789");
      const fingerprint = `SHA256:${"B".repeat(43)}`;
      const input = {
        kind: "sftp",
        label: "Client server",
        path: "/var/www/site",
        host: "sftp.example.com",
        port: 2222,
        username: "ada",
        auth: "password",
        hostKey: fingerprint,
        password: "correct horse battery",
      };
      const save = (over: Record<string, unknown> = {}, sealing: SiteSecrets | undefined = box) =>
        savePublishTarget(db.runner, admin, siteId, { ...input, ...over }, sealing);
      const added = await save();
      if (!added.ok) throw new Error(added.message);
      expect(added.target.sftp).toEqual({
        host: "sftp.example.com",
        port: 2222,
        username: "ada",
        hostKey: fingerprint,
        auth: "password",
      });
      // Sealed for this place and this name: it opens there and nowhere else, and the text is not in the database.
      const sealed = added.target.secrets!.password!;
      expect(box.open(sealed, secretPlace(added.target.id, "password"))).toBe(
        "correct horse battery",
      );
      expect(() => box.open(sealed, secretPlace("another", "password"))).toThrow();
      const stored = JSON.stringify(
        await db.run('select "value" from settings where key = ?', ["publish-targets"]),
      );
      expect(stored).not.toContain("correct horse battery");
      // The screen only learns that one is saved.
      expect(publicTarget((await listPublishTargets(db.runner, siteId))[0]!)).toMatchObject({
        has: { password: true, privateKey: false, passphrase: false },
      });
      expect(JSON.stringify(publicTarget(added.target))).not.toContain(sealed);
      // Changing the place without a password keeps the saved one; an empty one removes it (and then one is needed).
      const kept = await save({ id: added.target.id, password: undefined, label: "Renamed" });
      expect(kept.ok && kept.target.secrets!.password).toBe(sealed);
      expect(await save({ id: added.target.id, password: "" })).toMatchObject({
        ok: false,
        message: "Give the password.",
      });
      // A key needs a whole key, and changing to a key drops the password.
      expect(await save({ id: added.target.id, auth: "key", password: undefined })).toMatchObject({
        ok: false,
        message: "Paste the private key.",
      });
      expect(
        await save({
          id: added.target.id,
          auth: "key",
          password: undefined,
          privateKey: "not a key",
        }),
      ).toMatchObject({ ok: false });
      const withKey = await save({
        id: added.target.id,
        auth: "key",
        password: undefined,
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
        passphrase: "pass",
      });
      expect(withKey.ok && Object.keys(withKey.target.secrets!).sort()).toEqual([
        "passphrase",
        "privateKey",
      ]);
    });

    test("an SFTP place needs a good address, port, user name and a confirmed fingerprint, and a way to seal its secrets", async () => {
      const box = new SiteSecrets("a-site-secret-that-is-long-enough-0123456789");
      const good = {
        kind: "sftp",
        label: "S",
        path: "public_html",
        host: "sftp.example.com",
        username: "ada",
        hostKey: `SHA256:${"C".repeat(43)}`,
        password: "pw",
      };
      const save = (over: Record<string, unknown>, sealing: SiteSecrets | null = box) =>
        savePublishTarget(db.runner, admin, siteId, { ...good, ...over }, sealing ?? undefined);
      expect((await save({})).ok).toBe(true);
      for (const over of [
        { host: "bad host!" },
        { host: "" },
        { port: 0 },
        { port: 70000 },
        { port: "abc" },
        { username: "has space" },
        { username: "" },
        { hostKey: "" },
        { hostKey: "SHA256:short" },
        { path: "/" },
        { path: "a/../b" },
      ])
        expect(await save(over), JSON.stringify(over)).toMatchObject({
          ok: false,
          code: "invalid",
        });
      // Without a long enough OKS_SECRET a password cannot be sealed, and the words say what to set.
      expect(await save({}, null)).toMatchObject({
        ok: false,
        message: expect.stringContaining("OKS_SECRET"),
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
