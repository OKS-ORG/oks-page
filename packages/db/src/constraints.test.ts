// Spec 01 acceptance tests DM-01 to DM-15 and DM-28 to DM-31, run on SQLite and PostgreSQL.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ms, openers, type TestDb } from "./testing/harness.js";
import * as pgSchema from "./schema/pg.js";
import * as sqliteSchema from "./schema/sqlite.js";
import { eq } from "drizzle-orm";

let n = 0;
/** A fake 26-character id; unique within the test run. */
const id = (tag: string) =>
  `${tag.toUpperCase().padEnd(8, "0")}${String(++n).padStart(18, "0")}`.slice(0, 26);
const T = ms(1_700_000_000_123);

async function insert(db: TestDb, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await db.run(
    `insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")})`,
    Object.values(row),
  );
}
const count = async (db: TestDb, table: string, where = "1=1", params: unknown[] = []) =>
  Number((await db.run(`select count(*) as c from ${table} where ${where}`, params))[0]!["c"]);
/** The database must refuse the write, and for the stated reason (so a typo in a test cannot pass it). */
const reasons = {
  unique: /unique|duplicate/i,
  check: /check/i,
  json: /json|check/i,
  foreignKey: /foreign key/i,
};
const rejected = async (reason: keyof typeof reasons, p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return reasons[reason].test((e as Error).message);
  }
  return false;
};

const addSite = async (db: TestDb) => {
  const s = id("site");
  await insert(db, "sites", { id: s, name: "Test", created_at: T, updated_at: T });
  return s;
};
const addUser = async (db: TestDb, email = `${id("u")}@example.com`) => {
  const u = id("user");
  await insert(db, "users", { id: u, name: "User", email, created_at: T, updated_at: T });
  return u;
};
const addEntry = async (
  db: TestDb,
  o: {
    site: string;
    author: string;
    slug?: string;
    type?: string;
    locale?: string;
    status?: string;
    parent?: string | null;
  },
) => {
  const e = id("entry");
  await insert(db, "entries", {
    id: e,
    site_id: o.site,
    type_key: o.type ?? "post",
    title: "T",
    slug: o.slug ?? "hello",
    author_id: o.author,
    locale: o.locale ?? "",
    status: o.status ?? "published",
    parent_id: o.parent ?? null,
    fields: "{}",
    body: "[]",
    seo: "{}",
    meta: "{}",
    created_at: T,
    updated_at: T,
  });
  return e;
};

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: spec 01 constraints`, () => {
    let db: TestDb;
    beforeEach(async () => {
      db = await open();
    });
    afterEach(async () => {
      await db.close();
    });

    test("DM-01 a second entry with the same slug, type, language and site is rejected", async () => {
      const site = await addSite(db);
      const user = await addUser(db);
      await addEntry(db, { site, author: user });
      expect(await rejected("unique", addEntry(db, { site, author: user }))).toBe(true);
    });

    test("DM-02 the same slug is allowed for another type, language or site", async () => {
      const site = await addSite(db);
      const other = await addSite(db);
      const user = await addUser(db);
      await addEntry(db, { site, author: user });
      await addEntry(db, { site, author: user, type: "page" });
      await addEntry(db, { site, author: user, locale: "hi" });
      await addEntry(db, { site: other, author: user });
      expect(await count(db, "entries")).toBe(4);
    });

    test("DM-03 a trashed entry does not block its slug; restoring while the slug is taken fails", async () => {
      const site = await addSite(db);
      const user = await addUser(db);
      const trashed = await addEntry(db, { site, author: user, status: "trash" });
      await addEntry(db, { site, author: user, status: "published" });
      expect(
        await rejected(
          "unique",
          db.run("update entries set status = 'draft' where id = ?", [trashed]),
        ),
      ).toBe(true);
    });

    test("DM-04 an unknown entry status is rejected", async () => {
      const site = await addSite(db);
      const user = await addUser(db);
      expect(await rejected("check", addEntry(db, { site, author: user, status: "bogus" }))).toBe(
        true,
      );
    });

    test("DM-05 invalid JSON in a JSON column is rejected", async () => {
      const site = await addSite(db);
      const user = await addUser(db);
      const e = await addEntry(db, { site, author: user });
      expect(
        await rejected(
          "json",
          db.run("update entries set fields = ? where id = ?", ["{not json", e]),
        ),
      ).toBe(true);
    });

    test("DM-06 an id that is not 26 characters is rejected", async () => {
      expect(
        await rejected(
          "check",
          insert(db, "sites", { id: "short", name: "x", created_at: T, updated_at: T }),
        ),
      ).toBe(true);
    });

    test("DM-07 an entry for an unknown site is rejected", async () => {
      const user = await addUser(db);
      expect(await rejected("foreignKey", addEntry(db, { site: id("nosite"), author: user }))).toBe(
        true,
      );
    });

    test("DM-08 deleting an entry deletes revisions, comments, lock, term links and media links, and keeps the media row", async () => {
      const site = await addSite(db);
      const user = await addUser(db);
      const entry = await addEntry(db, { site, author: user });
      const tax = id("tax");
      await insert(db, "taxonomies", {
        id: tax,
        site_id: site,
        key: "category",
        label: "Category",
        applies_to: "[]",
      });
      const term = id("term");
      await insert(db, "terms", { id: term, taxonomy_id: tax, slug: "news", name: "News" });
      await insert(db, "entry_terms", { entry_id: entry, term_id: term });
      await insert(db, "entry_revisions", {
        id: id("rev"),
        entry_id: entry,
        kind: "revision",
        snapshot: "{}",
        author_id: user,
        created_at: T,
      });
      await insert(db, "comments", {
        id: id("com"),
        site_id: site,
        entry_id: entry,
        author_name: "A",
        content: "Hi",
        created_at: T,
      });
      await insert(db, "entry_locks", { entry_id: entry, user_id: user, expires_at: T });
      const media = id("media");
      await insert(db, "media", {
        id: media,
        site_id: site,
        storage_key: "a.jpg",
        filename: "a.jpg",
        mime_type: "image/jpeg",
        size_bytes: 10,
        content_hash: "h",
        uploaded_by: user,
        created_at: T,
      });
      await insert(db, "entry_media", { entry_id: entry, media_id: media, field: "featured" });
      await db.run("delete from entries where id = ?", [entry]);
      for (const t of ["entry_revisions", "comments", "entry_locks", "entry_terms", "entry_media"])
        expect(await count(db, t), t).toBe(0);
      expect(await count(db, "media")).toBe(1);
      expect(await count(db, "terms")).toBe(1);
    });

    test("DM-09 deleting a parent page keeps the children; their parent becomes empty", async () => {
      const site = await addSite(db);
      const user = await addUser(db);
      const parent = await addEntry(db, { site, author: user, slug: "parent", type: "page" });
      const child = await addEntry(db, { site, author: user, slug: "child", type: "page", parent });
      await db.run("delete from entries where id = ?", [parent]);
      const rows = await db.run("select parent_id from entries where id = ?", [child]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["parent_id"]).toBeNull();
    });

    test("DM-10 deleting a site deletes all of its data", async () => {
      const site = await addSite(db);
      const user = await addUser(db);
      const entry = await addEntry(db, { site, author: user });
      const role = id("role");
      await insert(db, "roles", {
        id: role,
        site_id: site,
        key: "editor",
        label: "Editor",
        created_at: T,
      });
      await insert(db, "role_capabilities", {
        id: id("cap"),
        role_id: role,
        capability: "entries.edit",
      });
      await insert(db, "site_members", {
        site_id: site,
        user_id: user,
        role_id: role,
        created_at: T,
      });
      await insert(db, "content_types", {
        id: id("ct"),
        site_id: site,
        key: "post",
        label: "Post",
        url_rule: "/{slug}",
        options: "{}",
        created_at: T,
        updated_at: T,
      });
      await insert(db, "settings", { site_id: site, key: "title", value: '"x"', updated_at: T });
      await insert(db, "redirects", {
        id: id("rd"),
        site_id: site,
        from_path: "/a",
        to_path: "/b",
        created_at: T,
      });
      await insert(db, "audit_log", {
        id: id("au"),
        site_id: site,
        actor_type: "user",
        actor_id: user,
        action: "x",
        detail: "{}",
        created_at: T,
      });
      await insert(db, "jobs", {
        id: id("job"),
        site_id: site,
        kind: "k",
        payload: "{}",
        run_at: T,
        created_at: T,
      });
      await db.run("delete from site_members where site_id = ?", [site]);
      await db.run("delete from sites where id = ?", [site]);
      for (const t of [
        "entries",
        "roles",
        "role_capabilities",
        "content_types",
        "settings",
        "redirects",
        "audit_log",
        "jobs",
      ])
        expect(await count(db, t), t).toBe(0);
      expect(entry).toBeTruthy();
    });

    test("DM-11 a role cannot get the same capability twice for the same scope", async () => {
      const site = await addSite(db);
      const role = id("role");
      await insert(db, "roles", { id: role, site_id: site, key: "r", label: "R", created_at: T });
      await insert(db, "role_capabilities", {
        id: id("cap"),
        role_id: role,
        capability: "entries.edit",
      });
      expect(
        await rejected(
          "unique",
          insert(db, "role_capabilities", {
            id: id("cap"),
            role_id: role,
            capability: "entries.edit",
          }),
        ),
      ).toBe(true);
    });

    test("DM-12 a capability can be given for different content types to the same role", async () => {
      const site = await addSite(db);
      const role = id("role");
      await insert(db, "roles", { id: role, site_id: site, key: "r", label: "R", created_at: T });
      await insert(db, "role_capabilities", {
        id: id("cap"),
        role_id: role,
        capability: "entries.edit",
        scope_type_key: "post",
      });
      await insert(db, "role_capabilities", {
        id: id("cap"),
        role_id: role,
        capability: "entries.edit",
        scope_type_key: "page",
      });
      expect(await count(db, "role_capabilities")).toBe(2);
    });

    test("DM-13 times keep millisecond precision", async () => {
      const d = db.drizzle(kind === "sqlite" ? sqliteSchema : pgSchema) as {
        insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> };
        select: () => {
          from: (t: unknown) => { where: (w: unknown) => Promise<{ createdAt: Date }[]> };
        };
      };
      const table = kind === "sqlite" ? sqliteSchema.sites : pgSchema.sites;
      const when = new Date(1_700_000_000_123);
      const siteId = id("site");
      await d.insert(table).values({ id: siteId, name: "t", createdAt: when, updatedAt: when });
      const rows = await d.select().from(table).where(eq(table.id, siteId));
      expect(rows[0]!.createdAt.getTime()).toBe(1_700_000_000_123);
    });

    test("DM-14 a plugin cannot store the same key twice in one collection", async () => {
      const site = await addSite(db);
      const ext = id("ext");
      await insert(db, "extensions", {
        id: ext,
        site_id: site,
        key: "forms",
        kind: "plugin",
        version: "1.0.0",
        tier: "runtime",
        installed_at: T,
      });
      const row = {
        extension_id: ext,
        collection: "c",
        key: "k",
        value: "1",
        size_bytes: 1,
        updated_at: T,
      };
      await insert(db, "extension_storage", row);
      expect(await rejected("unique", insert(db, "extension_storage", row))).toBe(true);
    });

    test("DM-15 an unknown extension tier or comment status is rejected", async () => {
      const site = await addSite(db);
      const user = await addUser(db);
      const entry = await addEntry(db, { site, author: user });
      expect(
        await rejected(
          "check",
          insert(db, "extensions", {
            id: id("ext"),
            site_id: site,
            key: "x",
            kind: "plugin",
            version: "1",
            tier: "weird",
            installed_at: T,
          }),
        ),
      ).toBe(true);
      expect(
        await rejected(
          "check",
          insert(db, "comments", {
            id: id("com"),
            site_id: site,
            entry_id: entry,
            author_name: "A",
            content: "x",
            status: "weird",
            created_at: T,
          }),
        ),
      ).toBe(true);
    });

    test("DM-28 an entry for an unknown user is rejected", async () => {
      const site = await addSite(db);
      expect(await rejected("foreignKey", addEntry(db, { site, author: id("nouser") }))).toBe(true);
    });

    test("DM-29 a user who authored entries cannot be deleted until the content is reassigned", async () => {
      const site = await addSite(db);
      const user = await addUser(db);
      const other = await addUser(db);
      const entry = await addEntry(db, { site, author: user });
      expect(await rejected("foreignKey", db.run("delete from users where id = ?", [user]))).toBe(
        true,
      );
      await db.run("update entries set author_id = ? where id = ?", [other, entry]);
      await db.run("delete from users where id = ?", [user]);
      expect(await count(db, "users", "id = ?", [user])).toBe(0);
    });

    test("DM-30 deleting a user deletes their sessions, passkeys, two-factor data and site memberships", async () => {
      const site = await addSite(db);
      const user = await addUser(db);
      const role = id("role");
      await insert(db, "roles", { id: role, site_id: site, key: "r", label: "R", created_at: T });
      await insert(db, "site_members", {
        site_id: site,
        user_id: user,
        role_id: role,
        created_at: T,
      });
      await insert(db, "auth_sessions", {
        id: id("ses"),
        user_id: user,
        token: "t1",
        expires_at: T,
        created_at: T,
        updated_at: T,
      });
      await insert(db, "passkeys", {
        id: id("pk"),
        user_id: user,
        public_key: "k",
        credential_id: "c1",
        counter: 0,
        device_type: "singleDevice",
        backed_up: false,
      });
      await insert(db, "two_factor", {
        id: id("tf"),
        user_id: user,
        secret: "s",
        backup_codes: "b",
      });
      await db.run("delete from users where id = ?", [user]);
      for (const t of ["site_members", "auth_sessions", "passkeys", "two_factor"])
        expect(await count(db, t), t).toBe(0);
    });

    test("DM-31 two users cannot share an email address; two passkeys cannot share a credential", async () => {
      await addUser(db, "same@example.com");
      expect(await rejected("unique", addUser(db, "same@example.com"))).toBe(true);
      const user = await addUser(db);
      const pk = {
        user_id: user,
        public_key: "k",
        credential_id: "dup",
        counter: 0,
        device_type: "x",
        backed_up: false,
      };
      await insert(db, "passkeys", { id: id("pk"), ...pk });
      expect(await rejected("unique", insert(db, "passkeys", { id: id("pk"), ...pk }))).toBe(true);
    });
  });
}
