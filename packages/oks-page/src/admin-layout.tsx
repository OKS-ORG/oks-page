// The layout around every admin page: it loads the admin's own name, logo, help link and footer line (white-label, spec 11,
// section 5) once and gives them to the screens. A site that is not set up yet, or a database that cannot be read, simply gets
// the product's own look: the admin must always open.
import {
  adminBrand,
  agencyActive,
  appearanceCss,
  DEFAULT_APPEARANCE,
  fontFaceCss,
  listLicences,
  loadAppearance,
  loadWhiteLabel,
  LOOKS,
  logoOf,
  needsAppearanceCss,
  pendingCommentCount,
  type Appearance,
} from "@oks-page/core";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "@oks-page/admin/shell.css";
import "@oks-page/admin/looks.css";
import "@oks-page/admin/base.css";
import { actorOf } from "./admin-actor";
import { AdminAppearanceProvider, NO_HINTS, type MenuHints } from "./admin-appearance-context";
import { AdminBrandProvider, NO_BRAND, type AdminBrandValue } from "./admin-brand-context";
import { signedInMember } from "./admin-session";
import { getRunner, getSiteId } from "./db";
import { licencePublicKeys } from "./licence-keys";
import { siteAppearance } from "./site-appearance";
import { mediaContext } from "./uploads";
import { currentUpdateView } from "./updates-context";
import { UpdateBanner } from "./update-banner";

async function loadBrand(): Promise<AdminBrandValue> {
  try {
    const runner = getRunner();
    const siteId = await getSiteId();
    const wl = await loadWhiteLabel(runner, siteId);
    if (
      wl.name === "" &&
      wl.logoId === null &&
      wl.helpUrl === "" &&
      wl.footer === "" &&
      wl.color === ""
    )
      return NO_BRAND;
    const host = ((await headers()).get("host") ?? "").replace(/:\d+$/, "");
    const agency = agencyActive(
      await listLicences(runner, siteId, licencePublicKeys()),
      host,
      new Date(),
    );
    let logoUrl: string | null = null;
    if (agency && wl.logoId) {
      const logo = await logoOf(runner, siteId, wl.logoId);
      if (logo) logoUrl = mediaContext().storage.publicUrl(logo.key);
    }
    return adminBrand(wl, agency, logoUrl);
  } catch {
    return NO_BRAND;
  }
}

/**
 * How the admin looks for whoever is signed in (their own choice over the site's default over the product's), and what the
 * menu shows beside its items: the comments waiting for those who may decide on them, an update waiting for those who manage the
 * settings. A failure in any part leaves that part out: the admin must always open.
 */
async function loadPerson(): Promise<{ appearance: Appearance; hints: MenuHints }> {
  const plain = { appearance: DEFAULT_APPEARANCE, hints: NO_HINTS };
  try {
    const member = await signedInMember({ allowSetup: true });
    if (!member) return plain;
    const runner = getRunner();
    const appearance = await loadAppearance(
      runner,
      member.siteId,
      member.user.id,
      await siteAppearance(member.siteId),
    );
    const hints: MenuHints = { commentsWaiting: 0, updateWaiting: false };
    if (!member.mustSetUpTwoFactor) {
      const actor = await actorOf(member);
      if (actor.can("comments.moderate"))
        hints.commentsWaiting = await pendingCommentCount(runner, member.siteId).catch(() => 0);
      if (actor.can("settings.manage")) {
        const view = await currentUpdateView(runner, member.siteId).catch(() => null);
        hints.updateWaiting =
          view?.comparison !== null &&
          view?.comparison !== undefined &&
          (view.comparison.core.behind || view.comparison.items.some((i) => i.behind));
      }
    }
    return { appearance, hints };
  } catch {
    return plain;
  }
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const [brand, person] = await Promise.all([loadBrand(), loadPerson()]);
  const { appearance, hints } = person;
  const look = LOOKS[appearance.look];
  const custom = needsAppearanceCss(appearance);
  return (
    <AdminBrandProvider brand={brand}>
      <AdminAppearanceProvider appearance={appearance} hints={hints}>
        <style
          dangerouslySetInnerHTML={{
            __html: fontFaceCss([...new Set([look.fonts.heading, look.fonts.text])]),
          }}
        />
        {/* Only colours and sizes made by the core from checked choices (a look, a mode, "#rrggbb"): nothing typed is written. */}
        {custom ? <style dangerouslySetInnerHTML={{ __html: appearanceCss(appearance) }} /> : null}
        <div
          className="oks-admin"
          data-look={look.key}
          data-mode={appearance.mode}
          {...(custom ? { "data-appearance": "custom" } : {})}
          data-branded={brand.name || brand.logoUrl ? "true" : "false"}
        >
          <UpdateBanner />
          {children}
        </div>
      </AdminAppearanceProvider>
    </AdminBrandProvider>
  );
}
