// Settings > Licences, for a signed-in member who may manage the settings.
import { isSetupDone, listLicences } from "@oks-page/core";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { describeLicences } from "./api-licences";
import { getRunner } from "./db";
import { LicencesScreen } from "./licences-screen";
import { licencePublicKeys } from "./licence-keys";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Licence keys", robots: { index: false } };

export default async function LicencesPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const keys = licencePublicKeys();
  const licences = await listLicences(getRunner(), member.siteId, keys);
  // The address the owner uses (without a port), for the development key rule.
  const host = ((await headers()).get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Licence keys"
      breadcrumbs={[{ label: "Settings" }, { label: "Licence keys" }]}
    >
      <SettingsLinks current="licences" />
      <LicencesScreen initial={describeLicences(licences, host)} canCheck={keys.length > 0} />
    </AdminFrame>
  );
}
