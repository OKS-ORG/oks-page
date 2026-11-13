// Settings > General, for a signed-in member who may manage the settings.
import { isSetupDone, loadGeneralSettings, timeZoneNames } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { GeneralSettingsFormScreen } from "./general-settings-form";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "General settings", robots: { index: false } };

export default async function GeneralSettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const settings = await loadGeneralSettings(getRunner(), member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="General settings"
      breadcrumbs={[{ label: "Settings" }, { label: "General" }]}
    >
      <SettingsLinks current="general" />
      <GeneralSettingsFormScreen initial={settings} zones={timeZoneNames()} />
    </AdminFrame>
  );
}
