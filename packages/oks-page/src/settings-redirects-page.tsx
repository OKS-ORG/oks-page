// Settings > Redirects, for a signed-in member who may manage the settings.
import { isSetupDone, listRedirects } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { RedirectsScreen } from "./redirects-screen";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Redirects", robots: { index: false } };

export default async function RedirectsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const redirects = await listRedirects(getRunner(), member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Redirects"
      breadcrumbs={[{ label: "Settings" }, { label: "Redirects" }]}
    >
      <SettingsLinks current="redirects" />
      <RedirectsScreen redirects={redirects} />
    </AdminFrame>
  );
}
