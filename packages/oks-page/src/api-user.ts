// /api/admin/users/[id]: PATCH {"role": "editor"} gives a person another role, DELETE takes them out of the site. Only people
// who manage users. The last administrator can be neither demoted nor removed.
import { changeMemberRole, removeMember } from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { USER_STATUS } from "./api-users";
import { getRunner } from "./db";

type Context = { params: Promise<{ id: string }> };

async function who(request: Request) {
  if (!isSameOrigin(request))
    return {
      error: reply({ code: "forbidden", message: "This request came from another address." }, 403),
    };
  const member = await signedInMember();
  if (!member) return { error: reply({ code: "forbidden", message: "Sign in first." }, 401) };
  return { member };
}

export async function PATCH(request: Request, context: Context) {
  const caller = await who(request);
  if (!caller.member) return caller.error;
  const { id } = await context.params;
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const result = await changeMemberRole(
    getRunner(),
    await actorOf(caller.member),
    caller.member.siteId,
    id,
    String(input["role"] ?? ""),
  );
  if (!result.ok) return reply(result, USER_STATUS[result.code]);
  return NextResponse.json({ ok: true, role: result.roleKey });
}

export async function DELETE(request: Request, context: Context) {
  const caller = await who(request);
  if (!caller.member) return caller.error;
  const { id } = await context.params;
  const result = await removeMember(
    getRunner(),
    await actorOf(caller.member),
    caller.member.siteId,
    id,
  );
  if (!result.ok) return reply(result, USER_STATUS[result.code]);
  return NextResponse.json({ ok: true });
}
