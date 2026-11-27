// The site's own default for how the admin looks, under every person's choice: an agency's look, light or dark, and brand colour
// (Settings > Branding), when an Agency licence key is active; otherwise the product's own default.
import {
  agencyActive,
  DEFAULT_APPEARANCE,
  DEFAULT_LOOK,
  listLicences,
  loadWhiteLabel,
  type Appearance,
} from "@oks-page/core";
import { headers } from "next/headers";
import { getRunner } from "./db";
import { licencePublicKeys } from "./licence-keys";

export async function siteAppearance(siteId: string): Promise<Appearance> {
  try {
    const runner = getRunner();
    const wl = await loadWhiteLabel(runner, siteId);
    if (wl.look === "" && wl.mode === "" && wl.color === "") return DEFAULT_APPEARANCE;
    const host = ((await headers()).get("host") ?? "").replace(/:\d+$/, "");
    const agency = agencyActive(
      await listLicences(runner, siteId, licencePublicKeys()),
      host,
      new Date(),
    );
    if (!agency) return DEFAULT_APPEARANCE;
    return {
      ...DEFAULT_APPEARANCE,
      look: wl.look || DEFAULT_LOOK,
      mode: wl.mode || DEFAULT_APPEARANCE.mode,
      accent: wl.color,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}
