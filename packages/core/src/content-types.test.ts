// Custom content types and fields made from the admin (spec 01; DM-18, DM-25). On SQLite and PostgreSQL.
import { newId } from "@oks-page/db";
import { openers, type TestDb } from "@oks-page/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDraft, loadForEdit, saveContent, type Actor } from "./content.js";
import {
  cleanFieldValues,
  deleteContentType,
  listContentTypes,
  saveContentType,
  type FieldDef,
} from "./content-types.js";
import { DEFAULT_ROLES } from "./roles.js";
import { runSetup } from "./setup.js";

const T = new Date(1_700_000_000_000);
const actorOf = (userId: string, role: string): Actor => {
  const caps = DEFAULT_ROLES.find((r) => r.key === role)!.capabilities;
  return { userId, can: (capability) => caps.includes(capability) };
};

const def = (over: Partial<FieldDef> & { key: string; type: FieldDef["type"] }): FieldDef => ({
  label: over.key,
  required: false,
  sortable: false,
  filterable: false,
  ...over,
});

describe("cleaning the values of an entry", () => {
  const defs = [
    def({ key: "price", type: "number", required: true }),
    def({ key: "sku", type: "text" }),
    def({ key: "on_sale", type: "true / false" }),
    def({ key: "released", type: "date" }),
  ];
  test("numbers, dates and true / false are checked; unknown keys are dropped", () => {
    expect(
      cleanFieldValues(defs, {
        price: "12.5",
        sku: "A1",
        on_sale: "true",
        released: "2026-03-04",
        x: 1,
      }),
    ).toEqual({
      ok: true,
      fields: { price: 12.5, sku: "A1", on_sale: true, released: "2026-03-04" },
    });
    expect(cleanFieldValues(defs, { price: 3 })).toEqual({
      ok: true,
      fields: { price: 3, on_sale: false },
    });
  });
  test("a missing required value, a bad number and a bad date are refused with the field named", () => {
    expect(cleanFieldValues(defs, {})).toMatchObject({ ok: false, field: "price" });
    expect(cleanFieldValues(defs, { price: "abc" })).toMatchObject({ ok: false, field: "price" });
    expect(cleanFieldValues(defs, { price: 1, released: "4 March" })).toMatchObject({
      ok: false,
      field: "released",
    });
  });
});

for (const { kind, open, skip } of openers) {
  describe.skipIf(skip)(`${kind}: content types`, () => {
    let db: TestDb;
    let siteId = "";
    let anna: Actor;
    let eve: Actor;

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
      anna = actorOf(setup.userId, "administrator");
      const eveId = newId();
      await db.run(
        "insert into users (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        [eveId, "Eve", "eve@example.com", T, T],
      );
      eve = actorOf(eveId, "editor");
    });
    afterEach(async () => db.close());

    const product = {
      key: "product",
      label: "Product",
      urlPrefix: "shop/",
      fields: [
        { key: "price", label: "Price", type: "number", required: true, sortable: true },
        { key: "sku", label: "Code", type: "text", filterable: true },
        { key: "notes", label: "Notes", type: "long text", sortable: true },
      ],
    };

    test("a new site has Page and Post, both built in", async () => {
      const list = await listContentTypes(db.runner, siteId);
      expect(list.map((t) => [t.key, t.builtIn])).toEqual([
        ["page", true],
        ["post", true],
      ]);
    });

    test("only people who manage content types may change them; Page and Post cannot be changed or deleted", async () => {
      expect(await saveContentType(db.runner, eve, siteId, product)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(
        await saveContentType(db.runner, anna, siteId, { key: "page", label: "X" }),
      ).toMatchObject({ ok: false, code: "invalid" });
      expect(await deleteContentType(db.runner, anna, siteId, "post")).toMatchObject({
        ok: false,
        code: "invalid",
      });
    });

    test("bad keys, prefixes and fields are refused with a plain message", async () => {
      const bad = (over: object) =>
        saveContentType(db.runner, anna, siteId, { ...product, ...over });
      expect(await bad({ key: "Product" })).toMatchObject({ ok: false, field: "key" });
      expect(await bad({ label: " " })).toMatchObject({ ok: false, field: "label" });
      expect(await bad({ urlPrefix: "Shop" })).toMatchObject({ ok: false, field: "urlPrefix" });
      expect(await bad({ urlPrefix: "admin/" })).toMatchObject({ ok: false, field: "urlPrefix" });
      expect(
        await bad({
          fields: [
            { key: "a", label: "A", type: "text" },
            { key: "a", label: "B", type: "text" },
          ],
        }),
      ).toMatchObject({ ok: false, field: "fields" });
      expect(await bad({ fields: [{ key: "a", label: "A", type: "color wheel" }] })).toMatchObject({
        ok: false,
        field: "fields",
      });
    });

    test("a type is made with its fields; sortable and filterable fields get an index, a long text never does", async () => {
      const saved = await saveContentType(db.runner, anna, siteId, product);
      expect(saved.ok).toBe(true);
      const t = (await listContentTypes(db.runner, siteId)).find((x) => x.key === "product")!;
      expect(t.urlPrefix).toBe("shop/");
      expect(t.fields.map((f) => [f.key, f.type, f.required, f.sortable, f.filterable])).toEqual([
        ["price", "number", true, true, false],
        ["sku", "text", false, false, true],
        ["notes", "long text", false, false, false],
      ]);
      const names = (
        kind === "sqlite"
          ? await db.runner.all(
              `select name from sqlite_master where type = 'index' and name like 'ix_ef_%'`,
            )
          : await db.runner.all(
              `select indexname as name from pg_indexes where schemaname = current_schema() and indexname like 'ix_ef_%'`,
            )
      ).length;
      expect(names).toBe(2);
      // Taking the flag away drops the index again.
      await saveContentType(db.runner, anna, siteId, {
        ...product,
        fields: [{ key: "price", label: "Price", type: "number" }],
      });
      const after = (
        kind === "sqlite"
          ? await db.runner.all(
              `select name from sqlite_master where type = 'index' and name like 'ix_ef_%'`,
            )
          : await db.runner.all(
              `select indexname as name from pg_indexes where schemaname = current_schema() and indexname like 'ix_ef_%'`,
            )
      ).length;
      expect(after).toBe(0);
    });

    test("entries of the type get the prefix, keep their values, and refuse bad ones", async () => {
      await saveContentType(db.runner, anna, siteId, product);
      const made = await createDraft(db.runner, anna, siteId, {
        type: "product",
        title: "Red shoe",
      });
      expect(made).toMatchObject({ ok: true, slug: "shop/red-shoe" });
      if (!made.ok) return;
      const loaded = await loadForEdit(db.runner, anna, siteId, made.id);
      expect(loaded.ok && loaded.entry.fieldDefs.map((f) => f.key)).toEqual([
        "price",
        "sku",
        "notes",
      ]);
      const save = (fields: unknown, revision: number) =>
        saveContent(db.runner, anna, siteId, made.id, {
          title: "Red shoe",
          slugPart: "red-shoe",
          status: "draft",
          blocks: [],
          revision,
          fields,
        });
      expect(await save({ sku: "A1" }, 1)).toMatchObject({
        ok: false,
        code: "invalid",
        field: "price",
      });
      expect(await save({ price: "49.9", sku: "A1", notes: "Comfy" }, 1)).toMatchObject({
        ok: true,
      });
      const again = await loadForEdit(db.runner, anna, siteId, made.id);
      expect(again.ok && again.entry.fieldValues).toEqual({
        price: 49.9,
        sku: "A1",
        notes: "Comfy",
      });
    });

    test("the prefix cannot change once entries exist, and a type with entries cannot be deleted", async () => {
      await saveContentType(db.runner, anna, siteId, product);
      const made = await createDraft(db.runner, anna, siteId, {
        type: "product",
        title: "Red shoe",
      });
      expect(made.ok).toBe(true);
      expect(
        await saveContentType(db.runner, anna, siteId, { ...product, urlPrefix: "store/" }),
      ).toMatchObject({ ok: false, field: "urlPrefix" });
      // The label and the fields can change.
      expect(
        await saveContentType(db.runner, anna, siteId, { ...product, label: "Goods" }),
      ).toMatchObject({ ok: true });
      expect(await deleteContentType(db.runner, anna, siteId, "product")).toMatchObject({
        ok: false,
        code: "invalid",
      });
      await db.run(`delete from entries where site_id = ?`, [siteId]);
      expect(await deleteContentType(db.runner, anna, siteId, "product")).toEqual({ ok: true });
      expect((await listContentTypes(db.runner, siteId)).map((t) => t.key)).toEqual([
        "page",
        "post",
      ]);
    });

    test("a type that does not exist cannot get an entry", async () => {
      expect(
        await createDraft(db.runner, anna, siteId, { type: "ghost", title: "x" }),
      ).toMatchObject({
        ok: false,
      });
    });
  });
}
