// /api/admin/taxonomies/[key]: GET the terms of Categories ("category") or Tags ("tag"), POST to add one.
import {
  createTerm,
  ensureDefaultTaxonomies,
  loadTaxonomy,
  type TaxonomyResult,
  type TermInput,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { refreshArchives } from "./refresh-cache";

type Context = { params: Promise<{ key: string }> };

export const TAXONOMY_STATUS = {
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  slug_taken: 409,
} as const;

/** The fields a request may carry, taken one by one so nothing else reaches the core. */
export function termInputFrom(input: Record<string, unknown>): TermInput {
  const out: TermInput = {};
  for (const key of ["name", "slug", "description"] as const)
    if (key in input) out[key] = input[key] as string;
  if ("parentId" in input) out.parentId = (input["parentId"] as string | null) || null;
  return out;
}

export function failed(result: Extract<TaxonomyResult<unknown>, { ok: false }>) {
  return reply(result, TAXONOMY_STATUS[result.code]);
}

export async function GET(_request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const actor = await actorOf(member);
  if (!actor.can("content.edit_any"))
    return reply({ code: "forbidden", message: "You may not see categories and tags." }, 403);
  const { key } = await context.params;
  await ensureDefaultTaxonomies(getRunner(), member.siteId);
  const taxonomy = await loadTaxonomy(getRunner(), member.siteId, key);
  if (!taxonomy) return reply({ code: "not_found", message: "There is no such list." }, 404);
  return NextResponse.json({ taxonomy });
}

export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { key } = await context.params;
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  await ensureDefaultTaxonomies(getRunner(), member.siteId);
  const result = await createTerm(
    getRunner(),
    await actorOf(member),
    member.siteId,
    key,
    termInputFrom(input),
  );
  if (!result.ok) return failed(result);
  refreshArchives();
  return NextResponse.json({ ok: true, id: result.id, slug: result.slug }, { status: 201 });
}
