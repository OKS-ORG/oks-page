// Who may open the preview of an entry: someone with a valid, unexpired link made for that entry, or a signed-in member who
// may edit it. Anyone else, and any error, means "no" (the answer is then a plain 404, so nobody learns that a draft exists).
import { capabilitiesOf } from "@oks-page/auth";
import {
  checkPreviewToken,
  loadForEdit,
  loadPreviewEntry,
  mustSetUpTwoFactor,
} from "@oks-page/core";
import { getAuth } from "./auth";
import { getRunner, getSiteId } from "./db";

export async function mayPreview(
  headers: Headers,
  id: string,
  token: string | null,
): Promise<boolean> {
  try {
    // A valid link only works while the entry exists (not in the trash). Checked here, before the page, so a link for an
    // entry that is gone gets a real 404 and not a "not found" page with status 200.
    if (token && checkPreviewToken(process.env["OKS_SECRET"] ?? "", id, token, Date.now()))
      return (await loadPreviewEntry(getRunner(), await getSiteId(), id)) !== null;
    const origin = `${headers.get("x-forwarded-proto") ?? "http"}://${headers.get("host") ?? "localhost"}`;
    const session = await getAuth(origin).auth.api.getSession!({ headers });
    if (!session?.user) return false;
    const siteId = await getSiteId();
    const userId = (session.user as { id: string }).id;
    // An administrator who still has to set up two-factor is treated as signed out everywhere (AU-37).
    if (await mustSetUpTwoFactor(getRunner(), siteId, userId)) return false;
    const caps = await capabilitiesOf(getRunner(), siteId, userId);
    const actor = {
      userId,
      can: (capability: string, typeKey?: string) => caps.can(capability, typeKey),
    };
    return (await loadForEdit(getRunner(), actor, siteId, id)).ok;
  } catch {
    return false;
  }
}
