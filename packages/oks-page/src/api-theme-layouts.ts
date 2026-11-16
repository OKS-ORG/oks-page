// /api/admin/themes/<id>/layouts: GET lists the theme's layouts with their state ("theme", "owner", "owner-outdated")
// and whether they have a draft; POST { action: "publish" } publishes every draft at once. Only people who may change
// the site design (`themes.manage`).
import {
  createOwnerLayout,
  listLayouts,
  loadThemeVersion,
  publishLayouts,
  typesWithoutLayout,
} from "@oks-page/core";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { refreshEntry } from "./refresh-cache";

type Context = { params: Promise<{ id: string }> };
export const LAYOUT_STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function GET(_request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await listLayouts(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  // The content types that have no page layout yet, for "a new layout for a content type".
  const types = await typesWithoutLayout(getRunner(), member.siteId, id);
  return NextResponse.json({ layouts: result.layouts, types });
}

export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  let input: { action?: unknown; name?: unknown; for?: unknown; from?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  if (input.action === "create") {
    const made = await createOwnerLayout(getRunner(), await actorOf(member), member.siteId, id, {
      name: input.name,
      for: input.for,
      from: input.from,
    });
    if (!made.ok) return reply(made, LAYOUT_STATUS[made.code]);
    // A layout for a content type is used by its entries at once.
    if (input.for !== "pages" && (await loadThemeVersion(getRunner(), member.siteId, id))?.isActive)
      revalidateTag("theme", { expire: 0 });
    return NextResponse.json({ ok: true, layout: made.layout }, { status: 201 });
  }
  if (input.action !== "publish")
    return reply({ code: "invalid", message: "Say what to do: publish or create." }, 400);
  const result = await publishLayouts(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  // The theme in use draws every public page, so all of them are written again at the next request.
  if (
    (result.published.length > 0 || result.sections.length > 0) &&
    (await loadThemeVersion(getRunner(), member.siteId, id))?.isActive
  )
    revalidateTag("theme", { expire: 0 });
  // The pages and posts that link to a section just published were written again: their caches are made fresh.
  for (const entry of result.entries) refreshEntry(entry.id, entry.slug);
  return NextResponse.json({ ok: true, published: result.published, sections: result.sections });
}
