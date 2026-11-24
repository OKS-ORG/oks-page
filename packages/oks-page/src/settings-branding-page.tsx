// Settings > Branding (spec 11, section 5): the admin's own name (free), and its logo, help link and footer line (Agency key).
import { agencyActive, isSetupDone, listLicences, listMedia, loadWhiteLabel } from "@oks-page/core";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { BrandingScreen } from "./branding-screen";
import { getRunner } from "./db";
import { licencePublicKeys } from "./licence-keys";
import { SettingsLinks } from "./settings-links";
import { mediaContext } from "./uploads";

export const metadata: Metadata = { title: "Branding", robots: { index: false } };

export default async function BrandingSettingsPage() {
  await connection();
  const runner = getRunner();
  if (!(await isSetupDone(runner))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const host = ((await headers()).get("host") ?? "").replace(/:\d+$/, "");
  const agency = agencyActive(
    await listLicences(runner, member.siteId, licencePublicKeys()),
    host,
    new Date(),
  );
  const listed = await listMedia(runner, mediaContext(), actor, member.siteId, { limit: 100 });
  const pictures = listed.ok
    ? listed.items
        .filter((m) => m.status === "ready" && /^image\/(png|jpeg|webp|avif)$/.test(m.mimeType))
        .map((m) => ({ id: m.id, name: m.fileName }))
    : [];
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Branding"
      breadcrumbs={[{ label: "Settings" }, { label: "Branding" }]}
    >
      <SettingsLinks current="branding" />
      <BrandingScreen
        initial={await loadWhiteLabel(runner, member.siteId)}
        agency={agency}
        pictures={pictures}
      />
    </AdminFrame>
  );
}
