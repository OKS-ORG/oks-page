// /api/admin/users: GET the people of the site with the roles and the waiting invitations, POST to invite someone. Only
// people who manage users. /api/admin/users/[id] (api-user.ts) changes a role or removes a person; /api/admin/invitations/[id]
// (api-invitation.ts) cancels an invitation.
import {
  createInvitation,
  listInvitations,
  listMembers,
  listRoles,
  type InviteInput,
  type UserErrorCode,
} from "@oks-page/core";
import { NextResponse } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { isSameOrigin, reply } from "./api-entries";
import { getRunner } from "./db";
import { siteOrigin } from "./site-origin";

export const USER_STATUS: Record<UserErrorCode, number> = {
  forbidden: 403,
  invalid: 400,
  not_found: 404,
  conflict: 409,
};

export async function GET() {
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  if (!(await actorOf(member)).can("users.manage"))
    return reply({ code: "forbidden", message: "You may not see the people of the site." }, 403);
  const runner = getRunner();
  return NextResponse.json({
    you: member.user.id,
    members: await listMembers(runner, member.siteId),
    roles: await listRoles(runner, member.siteId),
    invitations: await listInvitations(runner, member.siteId),
  });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  const member = await signedInMember();
  if (!member) return reply({ code: "forbidden", message: "Sign in first." }, 401);
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const invite: InviteInput = {
    name: input["name"] as string,
    email: input["email"] as string,
    roleKey: input["roleKey"] as string,
    ...(input["days"] === undefined ? {} : { days: Number(input["days"]) }),
  };
  const result = await createInvitation(getRunner(), await actorOf(member), member.siteId, invite);
  if (!result.ok) return reply(result, USER_STATUS[result.code]);
  return NextResponse.json(
    {
      link: `${siteOrigin(request)}/admin/invite/${result.token}`,
      invitation: result.invitation,
    },
    { status: 201 },
  );
}
