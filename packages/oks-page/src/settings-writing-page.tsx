// Settings > Writing (design batch 5), for a signed-in member who may manage the settings.
import {
  isSetupDone,
  layoutChoices,
  listCategoryChoices,
  loadWritingSettings,
} from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { SettingsLinks } from "./settings-links";
import { WritingSettingsScreen } from "./writing-settings-screen";

export const metadata: Metadata = { title: "Writing settings", robots: { index: false } };

export default async function WritingSettingsPage() {
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
      title="Writing settings"
      breadcrumbs={[{ label: "Settings" }, { label: "Writing" }]}
    >
      <SettingsLinks current="writing" />
      <WritingSettingsScreen
        initial={await loadWritingSettings(getRunner(), member.siteId)}
        categories={await listCategoryChoices(getRunner(), member.siteId)}
        layouts={await layoutChoices(getRunner(), member.siteId)}
      />
    </AdminFrame>
  );
}
