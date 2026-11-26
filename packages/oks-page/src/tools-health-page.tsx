// Tools > Site health (spec 07, section 16): one list of plain checks. Administrators only (people who manage the settings).
import { healthLine, isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { currentHealth } from "./health-context";
import { HealthScreen } from "./health-screen";

export const metadata: Metadata = { title: "Site health", robots: { index: false } };

export default async function ToolsHealthPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const report = await currentHealth(getRunner(), member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="health"
      title="Site health"
      breadcrumbs={[{ label: "Tools" }, { label: "Site health" }]}
    >
      <HealthScreen report={report} line={healthLine(report.summary)} />
    </AdminFrame>
  );
}
