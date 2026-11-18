// Settings > Screen sizes, for a signed-in member who may manage the settings.
import { isSetupDone, loadScreenSizes } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { ScreenSizesScreen } from "./screen-sizes-screen";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Screen sizes", robots: { index: false } };

export default async function ScreenSizesSettingsPage() {
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
      title="Screen sizes"
      breadcrumbs={[{ label: "Settings" }, { label: "Screen sizes" }]}
    >
      <SettingsLinks current="screens" />
      <ScreenSizesScreen initial={await loadScreenSizes(getRunner(), member.siteId)} />
    </AdminFrame>
  );
}
