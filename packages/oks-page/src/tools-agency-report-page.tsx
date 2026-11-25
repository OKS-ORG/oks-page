// /admin/tools/agency/report/<id>?days=30: the report an agency shows a client about the client's own site (spec 11, section 3). It is
// made when the page is opened, from what the site's connector says, and is laid out to print well (the admin's own menu is left out).
// For people who manage the settings, with an Agency key.
import {
  agencyActive,
  agencySiteLimit,
  buildClientReport,
  isSetupDone,
  listLicences,
  loadGeneralSettings,
  loadWhiteLabel,
  REPORT_DAYS,
} from "@oks-page/core";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { AgencyReportScreen } from "./agency-report-screen";
import { getRunner } from "./db";
import { licencePublicKeys } from "./licence-keys";
import { siteSecrets } from "./mail";

export const metadata: Metadata = {
  title: "Client report",
  robots: { index: false },
  referrer: "no-referrer",
};

export default async function ToolsAgencyReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  await connection();
  const runner = getRunner();
  if (!(await isSetupDone(runner))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const { id } = await params;
  const asked = Number((await searchParams).days ?? "30");
  const days = (REPORT_DAYS as readonly number[]).includes(asked) ? asked : 30;
  const host = ((await headers()).get("host") ?? "").replace(/:\d+$/, "");
  const licences = await listLicences(runner, member.siteId, licencePublicKeys());
  const now = new Date();
  const agency = {
    active: agencyActive(licences, host, now),
    limit: agencySiteLimit(licences, host, now),
  };
  const wl = await loadWhiteLabel(runner, member.siteId);
  const preparedBy = wl.name || (await loadGeneralSettings(runner, member.siteId)).siteName;
  const built = await buildClientReport(
    runner,
    actor,
    member.siteId,
    siteSecrets(),
    id,
    days,
    { fetch: globalThis.fetch, now: Date.now, timeoutMs: 8_000, agency },
    preparedBy,
  );
  return (
    <AgencyReportScreen
      id={id}
      days={days}
      report={built.ok ? built.report : null}
      problem={built.ok ? "" : built.message}
    />
  );
}
