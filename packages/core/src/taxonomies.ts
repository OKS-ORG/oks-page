// Categories and tags (spec 02, "Content" and design phase 1, screen 2). A taxonomy is a way to group entries; a term is
// one group in it. Every site has two: Categories (a tree, for posts) and Tags (flat, for posts). Deleting a category
// moves its posts to "Uncategorised", which always exists and cannot be deleted.
import { newId, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import { slugFromTitle } from "./content.js";

export const DEFAULT_TAXONOMIES = [
  { key: "category", label: "Categories", hierarchical: true },
  { key: "tag", label: "Tags", hierarchical: false },
] as const;

/** The term every post falls back to when it has no category. */
export const DEFAULT_CATEGORY_SLUG = "uncategorised";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

export interface TermView {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  description: string;
  /** How many entries (not in the trash) carry this term. */
  count: number;
}

export interface TaxonomyView {
  key: string;
  label: string;
  hierarchical: boolean;
  terms: TermView[];
}

export type TaxonomyResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: "forbidden" | "not_found" | "invalid" | "slug_taken"; message: string };

const fail = (code: "forbidden" | "not_found" | "invalid" | "slug_taken", message: string) =>
  ({ ok: false, code, message }) as const;

const isOn = (value: unknown): boolean => value === true || Number(value) === 1;

/**
 * Makes sure the site has its Categories and Tags and the "Uncategorised" category. Safe to call again and again, and
 * by two requests at once: a second insert of the same row does nothing.
 */
export async function ensureDefaultTaxonomies(runner: SqlRunner, siteId: string): Promise<void> {
  for (const t of DEFAULT_TAXONOMIES)
    await runner.all(
      `insert into "taxonomies" ("id", "site_id", "key", "label", "hierarchical", "applies_to") values (?, ?, ?, ?, ?, ?)
       on conflict ("site_id", "key") do nothing`,
      [newId(), siteId, t.key, t.label, t.hierarchical, JSON.stringify(["post"])],
    );
  const category = await runner.all(
    `select "id" from "taxonomies" where "site_id" = ? and "key" = 'category'`,
    [siteId],
  );
  await runner.all(
    `insert into "terms" ("id", "taxonomy_id", "slug", "name", "description") values (?, ?, ?, ?, '')
     on conflict ("taxonomy_id", "slug") do nothing`,
    [newId(), String(category[0]!["id"]), DEFAULT_CATEGORY_SLUG, "Uncategorised"],
  );
}

/** One taxonomy with its terms, in name order, each with the number of entries that carry it. */
export async function loadTaxonomy(
  runner: SqlRunner,
  siteId: string,
  key: string,
): Promise<TaxonomyView | null> {
  const found = await runner.all(
    `select "id", "key", "label", "hierarchical" from "taxonomies" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  const row = found[0];
  if (!row) return null;
  const terms = await runner.all(
    `select t."id", t."parent_id", t."slug", t."name", t."description",
            (select count(*) from "entry_terms" et join "entries" e on e."id" = et."entry_id"
              where et."term_id" = t."id" and e."status" <> 'trash') as "uses"
       from "terms" t where t."taxonomy_id" = ? order by t."name", t."id"`,
    [String(row["id"])],
  );
  return {
    key: String(row["key"]),
    label: String(row["label"]),
    hierarchical: isOn(row["hierarchical"]),
    terms: terms.map((t) => ({
      id: String(t["id"]),
      parentId: t["parent_id"] == null ? null : String(t["parent_id"]),
      slug: String(t["slug"]),
      name: String(t["name"]),
      description: String(t["description"]),
      count: Number(t["uses"]),
    })),
  };
}

export interface TermInput {
  name?: string;
  slug?: string;
  description?: string;
  /** Categories only: the term this one sits under, or null for the top. */
  parentId?: string | null;
}

interface TermRow {
  id: string;
  taxonomyId: string;
  key: string;
  hierarchical: boolean;
  parentId: string | null;
  slug: string;
}

async function termOf(runner: SqlRunner, siteId: string, termId: string): Promise<TermRow | null> {
  const rows = await runner.all(
    `select t."id", t."taxonomy_id", t."parent_id", t."slug", x."key", x."hierarchical"
       from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
      where t."id" = ? and x."site_id" = ?`,
    [termId, siteId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r["id"]),
    taxonomyId: String(r["taxonomy_id"]),
    key: String(r["key"]),
    hierarchical: isOn(r["hierarchical"]),
    parentId: r["parent_id"] == null ? null : String(r["parent_id"]),
    slug: String(r["slug"]),
  };
}

const slugTaken = async (
  runner: SqlRunner,
  taxonomyId: string,
  slug: string,
  exceptId = "",
): Promise<boolean> =>
  (
    await runner.all(
      `select 1 as found from "terms" where "taxonomy_id" = ? and "slug" = ? and "id" <> ? limit 1`,
      [taxonomyId, slug, exceptId],
    )
  ).length > 0;

function checkText(input: TermInput): string | null {
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return "Give it a name.";
    if (name.length > NAME_MAX) return `The name may have at most ${NAME_MAX} characters.`;
  }
  if (input.description !== undefined && input.description.length > DESCRIPTION_MAX)
    return `The description may have at most ${DESCRIPTION_MAX} characters.`;
  if (input.slug !== undefined && !SLUG.test(input.slug))
    return "The address may have only lower-case letters, numbers and single dashes.";
  return null;
}

/** Checks a parent: it must be in the same taxonomy, and moving a term under its own child would make a loop. */
async function checkParent(
  runner: SqlRunner,
  term: { taxonomyId: string; hierarchical: boolean; id?: string },
  parentId: string | null,
): Promise<string | null> {
  if (parentId === null) return null;
  if (!term.hierarchical) return "Tags have no parent.";
  const seen = new Set<string>();
  let at: string | null = parentId;
  while (at) {
    if (at === term.id || seen.has(at)) return "A category cannot sit under itself.";
    seen.add(at);
    const rows = await runner.all(`select "parent_id", "taxonomy_id" from "terms" where "id" = ?`, [
      at,
    ]);
    const row = rows[0];
    if (!row || String(row["taxonomy_id"]) !== term.taxonomyId)
      return "That parent is not in this list.";
    at = row["parent_id"] == null ? null : String(row["parent_id"]);
  }
  return null;
}

const MAY_MANAGE = "content.edit_any";

export async function createTerm(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  key: string,
  input: TermInput,
): Promise<TaxonomyResult<{ id: string; slug: string }>> {
  if (!actor.can(MAY_MANAGE)) return fail("forbidden", "You may not change categories and tags.");
  const taxonomy = await runner.all(
    `select "id", "hierarchical" from "taxonomies" where "site_id" = ? and "key" = ?`,
    [siteId, key],
  );
  if (!taxonomy[0]) return fail("not_found", "There is no such list.");
  const taxonomyId = String(taxonomy[0]["id"]);
  const name = (input.name ?? "").trim();
  if (!name) return fail("invalid", "Give it a name.");
  const problem = checkText(input);
  if (problem) return fail("invalid", problem);
  const parentId = input.parentId ?? null;
  const parentProblem = await checkParent(
    runner,
    { taxonomyId, hierarchical: isOn(taxonomy[0]["hierarchical"]) },
    parentId,
  );
  if (parentProblem) return fail("invalid", parentProblem);
  let slug = input.slug ?? "";
  if (slug) {
    if (await slugTaken(runner, taxonomyId, slug))
      return fail("slug_taken", "Another one already has this address.");
  } else {
    const base = slugFromTitle(name);
    slug = base;
    for (let n = 2; await slugTaken(runner, taxonomyId, slug); n++) slug = `${base}-${n}`;
  }
  const id = newId();
  await runner.all(
    `insert into "terms" ("id", "taxonomy_id", "parent_id", "slug", "name", "description") values (?, ?, ?, ?, ?, ?)`,
    [id, taxonomyId, parentId, slug, name, input.description ?? ""],
  );
  return { ok: true, id, slug };
}

export async function updateTerm(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  termId: string,
  input: TermInput,
): Promise<TaxonomyResult<{ slug: string }>> {
  if (!actor.can(MAY_MANAGE)) return fail("forbidden", "You may not change categories and tags.");
  const term = await termOf(runner, siteId, termId);
  if (!term) return fail("not_found", "There is no such item.");
  const problem = checkText(input);
  if (problem) return fail("invalid", problem);
  const protectedTerm = term.key === "category" && term.slug === DEFAULT_CATEGORY_SLUG;
  if (protectedTerm && input.slug !== undefined && input.slug !== term.slug)
    return fail("invalid", "The address of Uncategorised cannot change.");
  if (protectedTerm && input.parentId) return fail("invalid", "Uncategorised stays at the top.");
  if (input.parentId !== undefined) {
    const parentProblem = await checkParent(runner, term, input.parentId);
    if (parentProblem) return fail("invalid", parentProblem);
  }
  const slug = input.slug ?? term.slug;
  if (slug !== term.slug && (await slugTaken(runner, term.taxonomyId, slug, term.id)))
    return fail("slug_taken", "Another one already has this address.");
  const sets: string[] = [`"slug" = ?`];
  const values: unknown[] = [slug];
  if (input.name !== undefined) {
    sets.push(`"name" = ?`);
    values.push(input.name.trim());
  }
  if (input.description !== undefined) {
    sets.push(`"description" = ?`);
    values.push(input.description);
  }
  if (input.parentId !== undefined) {
    sets.push(`"parent_id" = ?`);
    values.push(input.parentId);
  }
  await runner.all(`update "terms" set ${sets.join(", ")} where "id" = ?`, [...values, term.id]);
  return { ok: true, slug };
}

/**
 * Deletes a term. Its children move up one level. Posts that had only this category move to "Uncategorised" (they are
 * never left without one); tags are simply taken off. "Uncategorised" itself cannot be deleted.
 */
export async function deleteTerm(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  termId: string,
): Promise<TaxonomyResult<{ moved: number }>> {
  if (!actor.can(MAY_MANAGE)) return fail("forbidden", "You may not change categories and tags.");
  const term = await termOf(runner, siteId, termId);
  if (!term) return fail("not_found", "There is no such item.");
  if (term.key === "category" && term.slug === DEFAULT_CATEGORY_SLUG)
    return fail("invalid", "Uncategorised cannot be deleted.");
  return runner.transaction(async (tx) => {
    let moved = 0;
    if (term.key === "category") {
      const fallback = await tx.all(
        `select "id" from "terms" where "taxonomy_id" = ? and "slug" = ?`,
        [term.taxonomyId, DEFAULT_CATEGORY_SLUG],
      );
      const fallbackId = String(fallback[0]!["id"]);
      const alone = await tx.all(
        `select et."entry_id" from "entry_terms" et where et."term_id" = ?
          and not exists (select 1 from "entry_terms" o join "terms" t on t."id" = o."term_id"
                           where o."entry_id" = et."entry_id" and t."taxonomy_id" = ? and o."term_id" <> ?)`,
        [term.id, term.taxonomyId, term.id],
      );
      for (const r of alone) {
        await tx.all(
          `insert into "entry_terms" ("entry_id", "term_id", "position") values (?, ?, 0)
           on conflict ("entry_id", "term_id") do nothing`,
          [String(r["entry_id"]), fallbackId],
        );
        moved++;
      }
    }
    await tx.all(`update "terms" set "parent_id" = ? where "parent_id" = ?`, [
      term.parentId,
      term.id,
    ]);
    await tx.all(`delete from "entry_terms" where "term_id" = ?`, [term.id]);
    await tx.all(`delete from "terms" where "id" = ?`, [term.id]);
    return { ok: true as const, moved };
  });
}
