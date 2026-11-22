// A column of files on a plugin's admin page (spec 16, section 6): each file of an item is a link for people who may open
// it, the CSV lists the names (never the bytes), and deleting an item from the page deletes its files. In SQLite and
// PostgreSQL.
import type { Actor } from "@oks-page/core";
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { actOnPluginPage, exportPluginPage, loadPluginPage } from "./plugin-pages";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000131";
const EXT = "EXT00000000000000000000131";
const owner: Actor = { userId: "USER0000000000000000000131", can: () => true };
const fid = (n: number) => `FILE${String(n).padStart(22, "0")}`;

const PAGE = {
  id: "messages",
  title: "Messages",
  view: {
    type: "table",
    source: "storage:messages",
    columns: [
      { field: "name", label: "Name" },
      { field: "files", label: "Files", format: "files" },
    ],
    actions: [{ id: "delete", label: "Delete", kind: "delete" }],
    export: true,
  },
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: files on a plugin's admin page`, () => {
    let db: TestDb;
    const put = (key: string, value: unknown) =>
      db.run(
        `insert into extension_storage (extension_id, collection, key, value, size_bytes, updated_at) values (?, 'messages', ?, ?, 10, ?)`,
        [EXT, key, JSON.stringify(value), T],
      );
    const file = (n: number, key: string) =>
      db.run(
        `insert into extension_files (id, extension_id, name, mime, size_bytes, sha256, status, collection, key, data, created_at) values (?, ?, ?, 'application/pdf', 4, 'x', 'kept', 'messages', ?, ?, ?)`,
        [fid(n), EXT, `doc-${n}.pdf`, key, Buffer.from([1, 2, 3, 4]), T],
      );
    const left = async () =>
      (await db.runner.all(`select "id" from extension_files order by "id"`)).map((r) =>
        String(r["id"]),
      );

    beforeAll(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, 'O', 'o@example.com', ?, ?)",
        [owner.userId, T, T],
      );
      await db.run(
        "insert into extensions (id, site_id, key, kind, version, tier, status, manifest, installed_at) values (?, ?, 'forms', 'plugin', '1.0.0', 'runtime', 'enabled', ?, ?)",
        [EXT, SITE, JSON.stringify({ displayName: "Forms", adminPages: [PAGE] }), T],
      );
      await db.run(
        "insert into extension_permissions (extension_id, permission, granted_by, granted_at) values (?, 'admin:pages', ?, ?)",
        [EXT, owner.userId, T],
      );
      await put("1", {
        name: "Anna",
        files: [
          { id: fid(1), name: "doc-1.pdf" },
          { id: fid(2), name: "doc-2.pdf" },
        ],
      });
      await put("2", {
        name: 'Ben, "B"',
        // Anything that is not a file of this kind is left out: a bad id, no name, a text, another shape.
        files: [
          { id: "short", name: "x.pdf" },
          { id: fid(3) },
          "doc.pdf",
          null,
          { id: fid(3), name: "doc-3.pdf" },
        ],
      });
      await put("3", { name: "Cleo" });
      await file(1, "1");
      await file(2, "1");
      await file(3, "2");
    });

    test("each file is a link to the admin address that opens it; an item with none has no links", async () => {
      const r = await loadPluginPage(db.runner, owner, SITE, "forms", "messages");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const byName = Object.fromEntries(r.view.rows.map((x) => [x.cells[0]!.text, x.cells[1]!]));
      expect(byName["Anna"]).toEqual({
        text: "doc-1.pdf, doc-2.pdf",
        links: [
          { text: "doc-1.pdf", href: `/api/admin/plugin-files/${fid(1)}` },
          { text: "doc-2.pdf", href: `/api/admin/plugin-files/${fid(2)}` },
        ],
      });
      expect(byName['Ben, "B"']).toEqual({
        text: "doc-3.pdf",
        links: [{ text: "doc-3.pdf", href: `/api/admin/plugin-files/${fid(3)}` }],
      });
      expect(byName["Cleo"]).toEqual({ text: "" });
    });

    test("the CSV lists the file names, never anything else of the files", async () => {
      const r = await exportPluginPage(db.runner, owner, SITE, "forms", "messages");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const lines = r.csv.trim().split("\r\n");
      expect(lines[0]).toBe("Name,Files");
      expect(lines).toContain("Anna,doc-1.pdf; doc-2.pdf");
      expect(r.csv).not.toContain(fid(1));
    });

    test("deleting an item from the page deletes its files, and no other", async () => {
      const done = await actOnPluginPage(
        db.runner,
        owner,
        SITE,
        "forms",
        "messages",
        "delete",
        "1",
      );
      expect(done.ok).toBe(true);
      expect(await left()).toEqual([fid(3)]);
    });
  });
}
