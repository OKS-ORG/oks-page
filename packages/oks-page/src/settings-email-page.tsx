// Settings > Email (spec 13, section 3), for a signed-in member who may manage the settings.
import { isSetupDone, listEmailLog, loadEmailSettings, SMTP_PRESETS } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { EmailSettingsScreen } from "./email-settings-screen";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Email settings", robots: { index: false } };

export default async function EmailSettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const settings = await loadEmailSettings(getRunner(), actor, member.siteId);
  const log = await listEmailLog(getRunner(), actor, member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Email settings"
      breadcrumbs={[{ label: "Settings" }, { label: "Email" }]}
    >
      <SettingsLinks current="email" />
      <EmailSettingsScreen
        initial={settings.ok ? settings.settings : null}
        presets={SMTP_PRESETS}
        initialLog={log.ok ? log.rows : []}
        adminEmail={member.user.email}
      />
    </AdminFrame>
  );
}
