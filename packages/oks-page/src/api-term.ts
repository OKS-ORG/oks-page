// /api/admin/terms/[id]: PATCH to change one category or tag, DELETE to remove it.
import { deleteTerm, updateTerm } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { failed, termInputFrom } from "./api-taxonomy";
import { getRunner } from "./db";
import { refreshArchives } from "./refresh-cache";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
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
  const result = await updateTerm(
    getRunner(),
    await actorOf(member),
    member.siteId,
    id,
    termInputFrom(input),
  );
  if (!result.ok) return failed(result);
  refreshArchives();
  return NextResponse.json({ ok: true, slug: result.slug });
}

export async function DELETE(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await deleteTerm(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return failed(result);
  refreshArchives();
  return NextResponse.json({ ok: true, moved: result.moved });
}
