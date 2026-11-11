// Who is looking at an admin page: the person signed in with Better Auth, who must also be a member of the site.
import { headers } from "next/headers";
import { getAuth } from "./auth";
import { getRunner, getSiteId } from "./db";

export interface SignedInMember {
  user: { id: string; name: string; email: string };
  siteId: string;
}

/** The signed-in member of the site, or null: no session, or a session of someone who is not a member. */
export async function signedInMember(): Promise<SignedInMember | null> {
  const requestHeaders = await headers();
  const origin = `${requestHeaders.get("x-forwarded-proto") ?? "http"}://${requestHeaders.get("host") ?? "localhost"}`;
  const session = await getAuth(origin).auth.api.getSession!({ headers: requestHeaders });
  if (!session?.user) return null;
  const siteId = await getSiteId();
  const member = await getRunner().all(
    `select 1 as found from "site_members" where "site_id" = ? and "user_id" = ? limit 1`,
    [siteId, session.user.id],
  );
  if (member.length === 0) return null;
  const { id, name, email } = session.user as { id: string; name: string; email: string };
  return { user: { id, name, email }, siteId };
}
