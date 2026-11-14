// Settings > Advanced (design batch 5): maintenance mode and the saved copies of pages. For a signed-in member who may manage
// the settings.
import { isSetupDone, loadMaintenanceSettings } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { SettingsLinks } from "./settings-links";
import { AdvancedSettingsScreen } from "./advanced-settings-screen";
import { COPIES_CLEARED_KEY } from "./api-settings-advanced";
import { MaintenanceSettingsFormScreen } from "./maintenance-settings-form";

export const metadata: Metadata = { title: "Advanced settings", robots: { index: false } };

export default async function AdvancedSettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const rows = await getRunner().all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [member.siteId, COPIES_CLEARED_KEY],
  );
  const raw = rows[0]?.["value"];
  const cleared = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    at: number;
    by: string;
  } | null;
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Advanced settings"
      breadcrumbs={[{ label: "Settings" }, { label: "Advanced" }]}
    >
      <SettingsLinks current="advanced" />
      <p>Settings most sites never need.</p>
      <section aria-labelledby="advanced-maintenance">
        <h2 id="advanced-maintenance">Maintenance mode</h2>
        <MaintenanceSettingsFormScreen
          initial={await loadMaintenanceSettings(getRunner(), member.siteId)}
        />
      </section>
      <AdvancedSettingsScreen lastCleared={cleared ?? null} />
    </AdminFrame>
  );
}
