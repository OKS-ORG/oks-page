// Settings > Privacy (design batch 5; spec 18), for a signed-in member who may manage the settings.
import {
  SITE_COOKIES,
  consentNeeded,
  KEEPING_RULES,
  isSetupDone,
  listPrivacyPageChoices,
  loadKeeping,
  loadPrivacySettings,
  noVisitorCookies,
} from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { loadConsentNeeds } from "./consent-needs";
import { getRunner } from "./db";
import { PrivacySettingsScreen } from "./privacy-settings-screen";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Privacy settings", robots: { index: false } };

export default async function PrivacySettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const needs = await loadConsentNeeds(getRunner(), member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Privacy settings"
      breadcrumbs={[{ label: "Settings" }, { label: "Privacy" }]}
    >
      <SettingsLinks current="privacy" />
      <PrivacySettingsScreen
        cookies={SITE_COOKIES}
        noVisitorCookies={noVisitorCookies()}
        consentNeeded={consentNeeded() || needs.needed}
        needs={needs}
        initial={await loadPrivacySettings(getRunner(), member.siteId)}
        pages={await listPrivacyPageChoices(getRunner(), member.siteId)}
        keeping={await loadKeeping(getRunner(), member.siteId)}
        keepingRules={KEEPING_RULES}
      />
    </AdminFrame>
  );
}
