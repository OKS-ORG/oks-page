// Who is looking at an admin page: the person signed in with Better Auth, who must also be a member of the site.
import { mustSetUpTwoFactor } from "@oks-page/core";
import { headers } from "next/headers";
import { getAuth } from "./auth";
import { getRunner, getSiteId } from "./db";

export interface SignedInMember {
  user: { id: string; name: string; email: string };
  siteId: string;
  /** True when the site requires two-factor for administrators and this administrator has not set it up yet. */
  mustSetUpTwoFactor: boolean;
}

/**
 * The signed-in member of the site, or null: no session, or a session of someone who is not a member.
 *
 * An administrator who must still set up two-factor (the site's rule, AU-37) is treated as not signed in everywhere,
 * so no screen and no API answers them, except the account screen and the sign-in page, which ask for `allowSetup`.
 */
export async function signedInMember(
  options: { allowSetup?: boolean } = {},
): Promise<SignedInMember | null> {
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
  const mustSetUp = await mustSetUpTwoFactor(getRunner(), siteId, id);
  if (mustSetUp && !options.allowSetup) return null;
  return { user: { id, name, email }, siteId, mustSetUpTwoFactor: mustSetUp };
}
