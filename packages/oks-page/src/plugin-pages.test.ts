// Admin pages of plugins (spec 04, section 9): the rows a plugin's page shows, the filters, the buttons on a row, the CSV
// export, and who may use them. In SQLite and PostgreSQL. The plugin's code is never run: the core reads its storage.
import type { Actor } from "@oks-page/core";
import { openers, type TestDb } from "@oks-page/db/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { actOnPluginPage, exportPluginPage, listPluginPages, loadPluginPage } from "./plugin-pages";

const T = new Date(1_700_000_000_000);
const SITE = "SITE0000000000000000000081";
const EXT = "EXT00000000000000000000081";
const EXT_NO = "EXT00000000000000000000082";
const EXT_OFF = "EXT00000000000000000000083";
const EXT_BAD = "EXT00000000000000000000084";

const owner: Actor = { userId: "USER0000000000000000000081", can: () => true };
const editor: Actor = { userId: "USER0000000000000000000082", can: () => false };

const PAGE = {
  id: "messages",
  title: "Messages",
  view: {
    type: "table",
    source: "storage:messages",
    order: "desc",
    columns: [
      { field: "at", label: "Received", format: "datetime" },
      { field: "title", label: "Form" },
      { field: "summary", label: "Message", truncate: 20 },
      { field: "constructor.name", label: "Nothing" },
    ],
    filters: [
      { label: "New", field: "status", value: "new" },
      { label: "Read", field: "status", value: "read" },
      { label: "Spam", field: "status", value: "spam" },
    ],
    actions: [
      { id: "read", label: "Mark as read", kind: "set", field: "status", value: "read" },
      { id: "delete", label: "Delete", kind: "delete" },
    ],
    export: true,
  },
};

const message = (status: string, summary: string, at = 1_700_000_000_000) => ({
  form: "f1",
  title: "Contact",
  status,
  at,
  summary,
  values: [],
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: admin pages of plugins`, () => {
    let db: TestDb;

    const put = (ext: string, collection: string, key: string, value: unknown) =>
      db.run(
        `insert into extension_storage (extension_id, collection, key, value, size_bytes, updated_at) values (?, ?, ?, ?, ?, ?)`,
        [ext, collection, key, JSON.stringify(value), 10, T],
      );
    const keys = async (filter: number, after?: string) => {
      const r = await loadPluginPage(db.runner, owner, SITE, "forms", "messages", {
        filter,
        ...(after ? { after } : {}),
      });
      if (!r.ok) throw new Error(r.message);
      return r.view;
    };

    beforeAll(async () => {
      db = await open();
      await db.run("insert into sites (id, name, created_at, updated_at) values (?, 'S', ?, ?)", [
        SITE,
        T,
        T,
      ]);
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, 'Owner', 'o@example.com', ?, ?)",
        [owner.userId, T, T],
      );
      const ext = async (
        id: string,
        key: string,
        status: string,
        manifest: unknown,
        perms: string[],
      ) => {
        await db.run(
          "insert into extensions (id, site_id, key, kind, version, tier, status, manifest, installed_at) values (?, ?, ?, 'plugin', '1.0.0', 'runtime', ?, ?, ?)",
          [id, SITE, key, status, JSON.stringify(manifest), T],
        );
        for (const p of perms)
          await db.run(
            "insert into extension_permissions (extension_id, permission, granted_by, granted_at) values (?, ?, ?, ?)",
            [id, p, owner.userId, T],
          );
      };
      const manifest = { displayName: "Forms", adminPages: [PAGE] };
      await ext(EXT, "forms", "enabled", manifest, ["admin:pages"]);
      // The permission was refused by the owner: no page, even though the manifest has one.
      await ext(EXT_NO, "refused", "enabled", manifest, []);
      await ext(EXT_OFF, "switched-off", "disabled", manifest, ["admin:pages"]);
      // A manifest that was damaged after it was stored shows nothing.
      await ext(
        EXT_BAD,
        "damaged",
        "enabled",
        { adminPages: [{ id: "x", title: "X", view: { type: "table", source: "elsewhere" } }] },
        ["admin:pages"],
      );
      await put(EXT, "messages", "000000000000001-a", message("new", "first", 1_700_000_000_000));
      await put(
        EXT,
        "messages",
        "000000000000002-b",
        message("new", "second one that is long enough to be cut", 1_700_000_100_000),
      );
      await put(EXT, "messages", "000000000000003-c", message("read", "third"));
      await put(
        EXT,
        "messages",
        "000000000000004-d",
        message("spam", '=HYPERLINK("http://x","click"), "quoted"'),
      );
      await put(EXT, "other", "k", { status: "new" });
      for (let i = 0; i < 60; i += 1)
        await put(EXT, "bulk", `k${String(i).padStart(3, "0")}`, {
          status: i % 2 ? "new" : "read",
        });
    });

    test("only a plugin that is on and was given admin:pages adds pages", async () => {
      const links = await listPluginPages(db.runner, SITE);
      expect(links).toEqual([
        { plugin: "forms", pluginName: "Forms", id: "messages", title: "Messages" },
      ]);
      for (const plugin of ["refused", "switched-off", "damaged", "nobody"]) {
        const r = await loadPluginPage(
          db.runner,
          owner,
          SITE,
          plugin,
          plugin === "damaged" ? "x" : "messages",
        );
        expect(r.ok).toBe(false);
      }
    });

    test("the rows of the first filter, newest first, with dates and cut text", async () => {
      const view = await keys(0);
      expect(view.title).toBe("Messages");
      expect(view.columns).toEqual(["Received", "Form", "Message", "Nothing"]);
      expect(view.filters).toEqual(["New", "Read", "Spam"]);
      expect(view.rows.map((r) => r.key)).toEqual(["000000000000002-b", "000000000000001-a"]);
      expect(view.rows[0]!.cells[0]!.text).toBe("2023-11-14 22:15 UTC");
      expect(view.rows[0]!.cells[1]!.text).toBe("Contact");
      // Long text is cut and keeps the whole text for the "show all" control.
      expect(view.rows[0]!.cells[2]).toEqual({
        text: "second one that is l…",
        full: "second one that is long enough to be cut",
      });
      // A name like constructor.name is not an item's own field: nothing is read from the language's built-ins.
      expect(view.rows[0]!.cells[3]!.text).toBe("");
      expect(view.actions.map((a) => [a.id, a.confirm])).toEqual([
        ["read", false],
        ["delete", true],
      ]);
      expect((await keys(1)).rows.map((r) => r.key)).toEqual(["000000000000003-c"]);
      expect((await keys(2)).rows.map((r) => r.key)).toEqual(["000000000000004-d"]);
      expect(view.next).toBeNull();
    });

    test("a long list is read a page at a time", async () => {
      // 60 items in all; the page shows 50 and says where the rest starts.
      const bulk = {
        ...PAGE,
        id: "bulk",
        title: "Bulk",
        view: {
          ...PAGE.view,
          source: "storage:bulk",
          filters: undefined,
          actions: undefined,
          export: false,
        },
      };
      await db.run(`update extensions set manifest = ? where id = ?`, [
        JSON.stringify({ displayName: "Forms", adminPages: [PAGE, bulk] }),
        EXT,
      ]);
      const first = await loadPluginPage(db.runner, owner, SITE, "forms", "bulk");
      expect(first.ok && first.view.rows.length).toBe(50);
      expect(first.ok && first.view.rows[0]!.key).toBe("k059");
      const next = first.ok ? first.view.next : null;
      expect(next).toBe("k010");
      const rest = await loadPluginPage(db.runner, owner, SITE, "forms", "bulk", { after: next });
      expect(rest.ok && rest.view.rows.map((r) => r.key)).toEqual(
        Array.from({ length: 10 }, (_, i) => `k${String(9 - i).padStart(3, "0")}`),
      );
      expect(rest.ok && rest.view.next).toBeNull();
      // A filter reads on until it has what it wants.
      await db.run(`update extensions set manifest = ? where id = ?`, [
        JSON.stringify({ displayName: "Forms", adminPages: [PAGE] }),
        EXT,
      ]);
    });

    test("people who may not manage plugins get nothing", async () => {
      const r = await loadPluginPage(db.runner, editor, SITE, "forms", "messages");
      expect(r.ok === false && r.code).toBe("forbidden");
      const a = await actOnPluginPage(
        db.runner,
        editor,
        SITE,
        "forms",
        "messages",
        "delete",
        "000000000000001-a",
      );
      expect(a.ok === false && a.code).toBe("forbidden");
      const e = await exportPluginPage(db.runner, editor, SITE, "forms", "messages");
      expect(e.ok === false && e.code).toBe("forbidden");
    });

    test("a button sets a field or deletes an item, and the audit log keeps names only", async () => {
      const done = await actOnPluginPage(
        db.runner,
        owner,
        SITE,
        "forms",
        "messages",
        "read",
        "000000000000001-a",
      );
      expect(done.ok).toBe(true);
      expect((await keys(0)).rows.map((r) => r.key)).toEqual(["000000000000002-b"]);
      expect((await keys(1)).rows.map((r) => r.key)).toEqual([
        "000000000000003-c",
        "000000000000001-a",
      ]);
      // The rest of the item is kept as it was.
      const kept = await loadPluginPage(db.runner, owner, SITE, "forms", "messages", { filter: 1 });
      expect(kept.ok && kept.view.rows[1]!.cells[2]!.text).toBe("first");
      const gone = await actOnPluginPage(
        db.runner,
        owner,
        SITE,
        "forms",
        "messages",
        "delete",
        "000000000000003-c",
      );
      expect(gone.ok).toBe(true);
      expect((await keys(1)).rows.map((r) => r.key)).toEqual(["000000000000001-a"]);
      const again = await actOnPluginPage(
        db.runner,
        owner,
        SITE,
        "forms",
        "messages",
        "delete",
        "000000000000003-c",
      );
      expect(again.ok === false && again.code).toBe("not_found");
      const unknown = await actOnPluginPage(
        db.runner,
        owner,
        SITE,
        "forms",
        "messages",
        "explode",
        "000000000000001-a",
      );
      expect(unknown.ok === false && unknown.code).toBe("invalid");
      // Another collection of the same plugin cannot be reached through this page.
      const other = await actOnPluginPage(
        db.runner,
        owner,
        SITE,
        "forms",
        "messages",
        "delete",
        "k",
      );
      expect(other.ok === false && other.code).toBe("not_found");
      const log = await db.runner.all(
        `select "action", "target_id", "detail" from audit_log where site_id = ? order by created_at, id`,
        [SITE],
      );
      expect(log.map((l) => l["action"])).toEqual(["plugin.page_action", "plugin.page_action"]);
      expect(JSON.stringify(log)).not.toContain("first");
    });

    test("the CSV has the columns, the whole text, and no live formulas", async () => {
      const spam = await exportPluginPage(db.runner, owner, SITE, "forms", "messages", 2);
      expect(spam.ok).toBe(true);
      if (!spam.ok) return;
      expect(spam.filename).toBe("forms-messages.csv");
      const lines = spam.csv.split("\r\n");
      expect(lines[0]).toBe("Received,Form,Message,Nothing");
      // A cell that starts with = is read as a formula by a spreadsheet: it gets a quote in front. Quotes are doubled.
      expect(lines[1]).toBe(
        `2023-11-14 22:13 UTC,Contact,"'=HYPERLINK(""http://x"",""click""), ""quoted""",`,
      );
      expect(spam.cut).toBe(false);
      const none = await exportPluginPage(db.runner, owner, SITE, "forms", "nobody", 0);
      expect(none.ok).toBe(false);
    });
  });
}
