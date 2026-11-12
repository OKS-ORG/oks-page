// /api/admin/redirects/[id]: DELETE one redirect. Only people who manage the settings.
import { deleteRedirect } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { REDIRECT_STATUS } from "./api-redirects";
import { getRunner } from "./db";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await deleteRedirect(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, REDIRECT_STATUS[result.code]);
  return NextResponse.json({ ok: true });
}
