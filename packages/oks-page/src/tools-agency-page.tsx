// Tools > Agency dashboard (spec 11, section 6): the client sites an agency looks after, with the last known state of each. Needs an
// Agency key to add or check sites. For a signed-in member who manages the site's settings.
import {
  agencyActive,
  agencySiteLimit,
  isSetupDone,
  listAgencySites,
  listLicences,
} from "@oks-page/core";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { AgencyScreen } from "./agency-screen";
import { getRunner } from "./db";
import { licencePublicKeys } from "./licence-keys";

export const metadata: Metadata = { title: "Agency dashboard", robots: { index: false } };

export default async function ToolsAgencyPage() {
  await connection();
  const runner = getRunner();
  if (!(await isSetupDone(runner))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const host = ((await headers()).get("host") ?? "").replace(/:\d+$/, "");
  const licences = await listLicences(runner, member.siteId, licencePublicKeys());
  const now = new Date();
  const sites = await listAgencySites(runner, actor, member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="agency"
      title="Agency dashboard"
      breadcrumbs={[{ label: "Tools" }, { label: "Agency dashboard" }]}
    >
      <AgencyScreen
        sites={sites}
        active={agencyActive(licences, host, now)}
        limit={agencySiteLimit(licences, host, now)}
      />
    </AdminFrame>
  );
}
