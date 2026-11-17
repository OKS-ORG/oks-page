// DELETE /api/admin/fonts/<key>: removes one of the site's own fonts, unless the look still uses it.
import { deleteOwnerFont } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

const STATUS = { forbidden: 403, invalid: 400, not_found: 404, in_use: 409 } as const;

export async function DELETE(request: Request, context: { params: Promise<{ key: string }> }) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { key } = await context.params;
  const result = await deleteOwnerFont(getRunner(), await actorOf(member), member.siteId, key);
  if (!result.ok) return reply(result, STATUS[result.code]);
  return NextResponse.json({ ok: true });
}
