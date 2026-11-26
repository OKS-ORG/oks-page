// The layout around every admin page: it loads the admin's own name, logo, help link and footer line (white-label, spec 11,
// section 5) once and gives them to the screens. A site that is not set up yet, or a database that cannot be read, simply gets
// the product's own look: the admin must always open.
import {
  adminBrand,
  agencyActive,
  fontFaceCss,
  listLicences,
  loadWhiteLabel,
  logoOf,
} from "@oks-page/core";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "@oks-page/admin/shell.css";
import "@oks-page/admin/base.css";
import { AdminBrandProvider, NO_BRAND, type AdminBrandValue } from "./admin-brand-context";
import { getRunner, getSiteId } from "./db";
import { licencePublicKeys } from "./licence-keys";
import { mediaContext } from "./uploads";
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

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const brand = await loadBrand();
  return (
    <AdminBrandProvider brand={brand}>
      <style dangerouslySetInnerHTML={{ __html: fontFaceCss(["inter"]) }} />
      <div className="oks-admin" data-branded={brand.name || brand.logoUrl ? "true" : "false"}>
        <UpdateBanner />
        {children}
      </div>
    </AdminBrandProvider>
  );
}
