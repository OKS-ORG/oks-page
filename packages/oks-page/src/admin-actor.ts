// Who is acting in the admin, as the core wants it: the person and what their role allows on this site.
import { capabilitiesOf } from "@oks-page/auth";
import type { Actor } from "@oks-page/core";
import { getRunner } from "./db";
import type { SignedInMember } from "./admin-session";

export async function actorOf(member: SignedInMember): Promise<Actor> {
  const caps = await capabilitiesOf(getRunner(), member.siteId, member.user.id);
  return { userId: member.user.id, can: (capability, typeKey) => caps.can(capability, typeKey) };
}
