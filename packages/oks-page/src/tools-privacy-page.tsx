// Tools > Privacy requests, for a signed-in member who manages the site's settings.
import { isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { PrivacyRequestsScreen } from "./privacy-requests-screen";

export const metadata: Metadata = { title: "Privacy requests", robots: { index: false } };

export default async function ToolsPrivacyPage() {
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
      selectedKey="privacy-requests"
      title="Privacy requests"
      breadcrumbs={[{ label: "Tools" }, { label: "Privacy requests" }]}
    >
      <PrivacyRequestsScreen />
    </AdminFrame>
  );
}
