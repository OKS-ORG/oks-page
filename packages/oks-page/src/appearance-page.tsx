// /admin/account/appearance: the look, light or dark, and the accent colour of the admin for the signed-in person.
import { isSetupDone, loadAppearance } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { AppearanceScreen } from "./appearance-screen";
import { getRunner } from "./db";
import { siteAppearance } from "./site-appearance";

export const metadata: Metadata = { title: "Appearance", robots: { index: false } };

export default async function AppearancePage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember({ allowSetup: true });
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  const site = await siteAppearance(member.siteId);
  const mine = await loadAppearance(getRunner(), member.siteId, member.user.id, site);
  return (
    <AdminFrame
      nav={member.mustSetUpTwoFactor ? [] : navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="account"
      title="Appearance"
      breadcrumbs={[{ label: "Your account", href: "/admin/account" }, { label: "Appearance" }]}
    >
      <AppearanceScreen initial={mine} siteDefault={site} />
    </AdminFrame>
  );
}
