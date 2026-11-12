// Who may see the real site while maintenance mode is on: a signed-in administrator (someone who may manage the
// settings). Anyone else, and any error, means "no": the visitor page is the safe answer.
import { capabilitiesOf } from "@oks-page/auth";
import { mustSetUpTwoFactor } from "@oks-page/core";
import { getAuth, requestOrigin } from "./auth";
import { getRunner, getSiteId } from "./db";

export async function mayPassMaintenance(request: Request): Promise<boolean> {
  try {
    const session = await getAuth(requestOrigin(request)).auth.api.getSession!({
      headers: request.headers,
    });
    if (!session?.user) return false;
    const siteId = await getSiteId();
    const userId = (session.user as { id: string }).id;
    const caps = await capabilitiesOf(getRunner(), siteId, userId);
    if (!caps.can("settings.manage")) return false;
    // An administrator who still has to set up two-factor is treated as signed out everywhere (AU-37).
    return !(await mustSetUpTwoFactor(getRunner(), siteId, userId));
  } catch {
    return false;
  }
}
