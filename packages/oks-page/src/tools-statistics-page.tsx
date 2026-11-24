// Tools > Statistics (spec 18, section 3): the daily totals of page views and visitors, the popular pages, where visitors came
// from, their countries and device types. For a signed-in member who manages the site's settings.
import { isSetupDone, loadStatistics, statisticsEnabled, type StatRow } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Statistics", robots: { index: false } };

const RANGES = [7, 30, 90] as const;

function Table({ title, rows, what }: { title: string; rows: StatRow[]; what: string }) {
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p>Nothing counted yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{what}</th>
              <th scope="col">Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.key}</th>
                <td>{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default async function ToolsStatisticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const asked = Number((await searchParams).days);
  const days = (RANGES as readonly number[]).includes(asked) ? asked : 7;
  const [stats, counting] = await Promise.all([
    loadStatistics(getRunner(), member.siteId, days),
    statisticsEnabled(getRunner(), member.siteId),
  ]);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="statistics"
      title="Statistics"
      breadcrumbs={[{ label: "Tools" }, { label: "Statistics" }]}
    >
      {counting ? null : (
        <p role="note">
          Counting visitors is switched off, so nothing new is added.{" "}
          <a href="/admin/settings/privacy">Open the privacy settings</a>
        </p>
      )}
      <p>
        Counted without cookies and without keeping anyone&apos;s address. A visitor who comes on
        two days is counted on both, because nobody can be followed from one day to the next.
        Browsers that send &ldquo;do not track&rdquo; and robots are not counted.
      </p>
      <nav aria-label="Time range">
        <ul style={{ display: "flex", gap: "1rem", listStyle: "none", padding: 0 }}>
          {RANGES.map((r) => (
            <li key={r}>
              {r === days ? (
                <strong aria-current="page">Last {r} days</strong>
              ) : (
                <a href={`/admin/tools/statistics?days=${r}`}>Last {r} days</a>
              )}
            </li>
          ))}
        </ul>
      </nav>
      <section aria-label="Totals">
        <h2>Totals, last {days} days</h2>
        <p>
          <strong>{stats.visitors}</strong> visitor{stats.visitors === 1 ? "" : "s"} (added up over
          the days) and <strong>{stats.views}</strong> page view{stats.views === 1 ? "" : "s"}.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Visitors</th>
              <th scope="col">Page views</th>
            </tr>
          </thead>
          <tbody>
            {[...stats.days].reverse().map((d) => (
              <tr key={d.day}>
                <th scope="row">{d.day}</th>
                <td>{d.visitors}</td>
                <td>{d.views}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <Table title="Popular pages" rows={stats.pages} what="Page" />
      <Table title="From search engines" rows={stats.searches} what="Search engine" />
      <Table title="From other sites" rows={stats.referrers} what="Site" />
      <Table title="Countries" rows={stats.countries} what="Country" />
      <Table title="Devices" rows={stats.devices} what="Device" />
    </AdminFrame>
  );
}
