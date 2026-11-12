// /api/admin/entries/[id]/terms: GET the categories to choose from and what the entry has, PUT to choose them.
import {
  ensureDefaultTaxonomies,
  loadEntryTerms,
  loadForEdit,
  loadTaxonomy,
  setEntryTerms,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { STATUS_OF, isSameOrigin, reply } from "./api-entries";
import { TAXONOMY_STATUS } from "./api-taxonomy";
import { getRunner } from "./db";
import { refreshArchives } from "./refresh-cache";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const runner = getRunner();
  const loaded = await loadForEdit(runner, await actorOf(member), member.siteId, id);
  if (!loaded.ok) return reply(loaded, STATUS_OF[loaded.code]);
  await ensureDefaultTaxonomies(runner, member.siteId);
  const categories = (await loadTaxonomy(runner, member.siteId, "category"))!.terms;
  const chosen = await loadEntryTerms(runner, member.siteId, id);
  return NextResponse.json({
    categories: categories.map(({ id: termId, name, parentId }) => ({
      id: termId,
      name,
      parentId,
    })),
    selected: { categoryIds: chosen.categoryIds, tags: chosen.tags.map((t) => t.name) },
  });
}

export async function PUT(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await setEntryTerms(getRunner(), await actorOf(member), member.siteId, id, {
    categoryIds: input["categoryIds"],
    tags: input["tags"],
  });
  if (!result.ok) return reply(result, TAXONOMY_STATUS[result.code]);
  refreshArchives();
  return NextResponse.json({
    ok: true,
    categoryIds: result.categoryIds,
    tags: result.tags.map((t) => t.name),
  });
}
