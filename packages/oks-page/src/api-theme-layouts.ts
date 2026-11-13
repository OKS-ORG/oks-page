// /api/admin/themes/<id>/layouts: GET lists the theme's layouts with their state ("theme", "owner", "owner-outdated")
// and whether they have a draft; POST { action: "publish" } publishes every draft at once. Only people who may change
// the site design (`themes.manage`).
import { listLayouts, loadThemeVersion, publishLayouts } from "@oks-page/core";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

type Context = { params: Promise<{ id: string }> };
export const LAYOUT_STATUS = { forbidden: 403, invalid: 400, not_found: 404 } as const;

export async function GET(_request: Request, context: Context) {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await listLayouts(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  return NextResponse.json({ layouts: result.layouts });
}

export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  let input: { action?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  if (input.action !== "publish")
    return reply({ code: "invalid", message: "Say what to do: publish." }, 400);
  const result = await publishLayouts(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, LAYOUT_STATUS[result.code]);
  // The theme in use draws every public page, so all of them are written again at the next request.
  if (
    result.published.length > 0 &&
    (await loadThemeVersion(getRunner(), member.siteId, id))?.isActive
  )
    revalidateTag("theme", { expire: 0 });
  return NextResponse.json({ ok: true, published: result.published });
}
