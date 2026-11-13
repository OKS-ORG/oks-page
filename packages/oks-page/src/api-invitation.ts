// /api/admin/invitations/[id]: DELETE cancels an invitation; its link stops working at once. Only people who manage users.
import { revokeInvitation } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { USER_STATUS } from "./api-users";
import { getRunner } from "./db";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await revokeInvitation(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, USER_STATUS[result.code]);
  return NextResponse.json({ ok: true });
}
