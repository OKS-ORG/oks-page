// Settings > Languages (design batch 5), for a signed-in member who may manage the settings.
import { isSetupDone, loadSiteLanguage, SITE_LANGUAGES } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { LanguageSettingsScreen } from "./language-settings-screen";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Languages settings", robots: { index: false } };

export default async function LanguagesSettingsPage() {
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
      title="Languages settings"
      breadcrumbs={[{ label: "Settings" }, { label: "Languages" }]}
    >
      <SettingsLinks current="languages" />
      <LanguageSettingsScreen
        initial={await loadSiteLanguage(getRunner(), member.siteId)}
        languages={SITE_LANGUAGES}
      />
    </AdminFrame>
  );
}
