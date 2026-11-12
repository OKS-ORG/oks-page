// The categories and tags of one entry: reading them and choosing them (the post editor's panel).
import { newId, type SqlRunner } from "@oks-page/db";
import { loadForEdit, slugFromTitle, type Actor } from "./content.js";
import {
  DEFAULT_CATEGORY_SLUG,
  ensureDefaultTaxonomies,
  type TaxonomyResult,
} from "./taxonomies.js";

export interface EntryTerms {
  categoryIds: string[];
  tags: { id: string; name: string }[];
}

const MAX_CHOSEN = 20;
const NAME_MAX = 80;

type Failure = Extract<TaxonomyResult<unknown>, { ok: false }>;
const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

/** The categories and tags one entry carries, in the order they were chosen. */
export async function loadEntryTerms(
  runner: SqlRunner,
  siteId: string,
  entryId: string,
): Promise<EntryTerms> {
  const rows = await runner.all(
    `select t."id", t."name", x."key" from "entry_terms" et
       join "terms" t on t."id" = et."term_id" join "taxonomies" x on x."id" = t."taxonomy_id"
      where et."entry_id" = ? and x."site_id" = ? order by et."position", t."name"`,
    [entryId, siteId],
  );
  return {
    categoryIds: rows.filter((r) => r["key"] === "category").map((r) => String(r["id"])),
    tags: rows
      .filter((r) => r["key"] === "tag")
      .map((r) => ({ id: String(r["id"]), name: String(r["name"]) })),
  };
}

/**
 * Sets the categories and tags of an entry (replacing what it had). An entry with no category gets "Uncategorised".
 * Tags are given by name: one that does not exist yet is made. Only people who may edit the entry can do this, and
 * only for the kinds of content the lists apply to (posts).
 */
export async function setEntryTerms(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  entryId: string,
  input: { categoryIds: unknown; tags: unknown },
): Promise<TaxonomyResult<EntryTerms>> {
  const loaded = await loadForEdit(runner, actor, siteId, entryId);
  if (!loaded.ok)
    return fail(loaded.code === "forbidden" ? "forbidden" : "not_found", loaded.message);
  await ensureDefaultTaxonomies(runner, siteId);
  const lists = await runner.all(
    `select "id", "key", "applies_to" from "taxonomies" where "site_id" = ? and "key" in ('category', 'tag')`,
    [siteId],
  );
  const taxonomyId = (key: string) => String(lists.find((r) => r["key"] === key)!["id"]);
  const applies = lists.every((r) => {
    const raw = r["applies_to"];
    const types = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    return Array.isArray(types) && types.includes(loaded.entry.type);
  });
  if (!applies) return fail("invalid", "This kind of content has no categories or tags.");

  if (!Array.isArray(input.categoryIds) || input.categoryIds.some((v) => typeof v !== "string"))
    return fail("invalid", "The categories were not understood.");
  if (!Array.isArray(input.tags) || input.tags.some((v) => typeof v !== "string"))
    return fail("invalid", "The tags were not understood.");
  const categoryIds = [...new Set(input.categoryIds as string[])];
  const tagNames = (input.tags as string[]).map((t) => t.trim()).filter(Boolean);
  if (categoryIds.length > MAX_CHOSEN || tagNames.length > MAX_CHOSEN)
    return fail("invalid", `Choose at most ${MAX_CHOSEN} categories and ${MAX_CHOSEN} tags.`);
  if (tagNames.some((t) => t.length > NAME_MAX))
    return fail("invalid", `A tag may have at most ${NAME_MAX} characters.`);
  for (const id of categoryIds) {
    const found = await runner.all(
      `select 1 as found from "terms" where "id" = ? and "taxonomy_id" = ?`,
      [id, taxonomyId("category")],
    );
    if (found.length === 0) return fail("invalid", "One of the categories does not exist.");
  }
  if (categoryIds.length === 0) {
    const fallback = await runner.all(
      `select "id" from "terms" where "taxonomy_id" = ? and "slug" = ?`,
      [taxonomyId("category"), DEFAULT_CATEGORY_SLUG],
    );
    categoryIds.push(String(fallback[0]!["id"]));
  }

  await runner.transaction(async (tx) => {
    const tagIds: string[] = [];
    for (const name of tagNames) {
      const slug = slugFromTitle(name);
      await tx.all(
        `insert into "terms" ("id", "taxonomy_id", "slug", "name", "description") values (?, ?, ?, ?, '')
         on conflict ("taxonomy_id", "slug") do nothing`,
        [newId(), taxonomyId("tag"), slug, name],
      );
      const row = await tx.all(`select "id" from "terms" where "taxonomy_id" = ? and "slug" = ?`, [
        taxonomyId("tag"),
        slug,
      ]);
      const id = String(row[0]!["id"]);
      if (!tagIds.includes(id)) tagIds.push(id);
    }
    await tx.all(
      `delete from "entry_terms" where "entry_id" = ? and "term_id" in (select "id" from "terms" where "taxonomy_id" in (?, ?))`,
      [entryId, taxonomyId("category"), taxonomyId("tag")],
    );
    let position = 0;
    for (const id of [...categoryIds, ...tagIds])
      await tx.all(
        `insert into "entry_terms" ("entry_id", "term_id", "position") values (?, ?, ?)`,
        [entryId, id, position++],
      );
  });
  return { ok: true, ...(await loadEntryTerms(runner, siteId, entryId)) };
}
