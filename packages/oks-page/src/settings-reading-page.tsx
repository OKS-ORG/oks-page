// Settings > Reading (design batch 5), for a signed-in member who may manage the settings.
import { isSetupDone, listPageChoices, loadReadingSettings } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { ReadingSettingsScreen } from "./reading-settings-screen";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Reading settings", robots: { index: false } };

export default async function ReadingSettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Reading settings"
      breadcrumbs={[{ label: "Settings" }, { label: "Reading" }]}
    >
      <SettingsLinks current="reading" />
      <ReadingSettingsScreen
        initial={await loadReadingSettings(getRunner(), member.siteId)}
        pages={await listPageChoices(getRunner(), member.siteId)}
      />
    </AdminFrame>
  );
}
