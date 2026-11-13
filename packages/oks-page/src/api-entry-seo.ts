// /api/admin/entries/[id]/seo: GET what the SEO box shows (the description and the "do not list" switch), PUT to change it
// ({"description", "noindex"}; only what is sent changes). Only people who may edit the entry. The public page, the sitemap, the
// search and the feeds show the change at once.
import { loadEntrySeo, setEntrySeo } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { refreshEntry } from "./refresh-cache";

const STATUS = { forbidden: 403, not_found: 404, invalid: 400 } as const;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await loadEntrySeo(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ seo: result.seo });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
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
  const result = await setEntrySeo(getRunner(), await actorOf(member), member.siteId, id, {
    ...("description" in input ? { description: input["description"] } : {}),
    ...("noindex" in input ? { noindex: input["noindex"] } : {}),
  });
  if (!result.ok) return reply(result, STATUS[result.code]);
  refreshEntry(id, result.slug);
  return NextResponse.json({ ok: true, seo: result.seo });
}
