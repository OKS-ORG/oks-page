// Settings > Search engines, for a signed-in member who may manage the settings.
import { isSetupDone, loadSeoSettings } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { SeoSettingsFormScreen } from "./seo-settings-form";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Search engine settings", robots: { index: false } };

export default async function SeoSettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const settings = await loadSeoSettings(getRunner(), member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Search engine settings"
      breadcrumbs={[{ label: "Settings" }, { label: "Search engines" }]}
    >
      <SettingsLinks current="seo" />
      <SeoSettingsFormScreen initial={settings} />
    </AdminFrame>
  );
}
