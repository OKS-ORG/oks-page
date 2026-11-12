// Settings > Media, for a signed-in member who may manage the settings.
import { isSetupDone, loadMediaSettingsForm } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { MediaSettingsFormScreen } from "./media-settings-form";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Media settings", robots: { index: false } };

export default async function MediaSettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const settings = await loadMediaSettingsForm(getRunner(), member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Media settings"
      breadcrumbs={[{ label: "Settings" }, { label: "Media" }]}
    >
      <SettingsLinks current="media" />
      <MediaSettingsFormScreen initial={settings} />
    </AdminFrame>
  );
}
