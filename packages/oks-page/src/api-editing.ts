// /api/admin/entries/[id]/editing: POST renews "I am editing this" and says who else is ({"otherEditor": name|null});
// DELETE says the person has left. It only informs: nobody is ever locked out.
import { stopEditing, touchEditing } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { STATUS_OF, isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  const result = await touchEditing(getRunner(), await actorOf(member), member.siteId, id);
  if (!result.ok) return reply(result, STATUS_OF[result.code]);
  return NextResponse.json({ otherEditor: result.otherEditor });
}

export async function DELETE(request: Request, context: Context) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  const { id } = await context.params;
  await stopEditing(getRunner(), await actorOf(member), id);
  return NextResponse.json({ ok: true });
}
