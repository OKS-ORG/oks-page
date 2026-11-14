// Tools > Site search (spec 08, section 16.3): popular searches and searches with no results for the last 90 days. Only
// the words, the day and the counts are kept, so nothing here points to a person.
import {
  SEARCH_STATS_DAYS,
  isSetupDone,
  loadSearchStats,
  type SearchTermCount,
} from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Site search", robots: { index: false } };

// Links in the table are at least 24 px tall (WCAG 2.2 target size).
const LINK: React.CSSProperties = {
  display: "inline-block",
  minBlockSize: "24px",
  lineHeight: "24px",
};

const searchLink = (term: string) => `/search?q=${encodeURIComponent(term)}&exact=1`;

function TermTable({
  id,
  caption,
  rows,
  column,
}: {
  id: string;
  caption: string;
  rows: SearchTermCount[];
  column: "searches" | "noResults";
}) {
  return (
    <table aria-labelledby={id}>
      <caption style={{ captionSide: "bottom", textAlign: "start" }}>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Words</th>
          <th scope="col">{column === "searches" ? "Searches" : "Searches with no results"}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.term}>
            <th scope="row">
              <a href={searchLink(r.term)} style={LINK}>
                {r.term}
              </a>
            </th>
            <td>{column === "searches" ? r.searches : r.noResults}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function SiteSearchToolPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const stats = await loadSearchStats(getRunner(), member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="tools"
      title="Site search"
      breadcrumbs={[{ label: "Tools" }, { label: "Site search" }]}
    >
      <p>
        What visitors searched for on your site in the last {SEARCH_STATS_DAYS} days:{" "}
        {stats.total === 1 ? "1 search" : `${stats.total} searches`}. Only the words, the day and
        the counts are kept: nothing that points to a person. Searches that look like an email
        address, a phone number or a long number are not kept at all.
      </p>
      <section aria-labelledby="search-popular">
        <h2 id="search-popular">Popular searches</h2>
        {stats.popular.length === 0 ? (
          <p>No searches yet. Visitors search at /search, or with a search box your theme shows.</p>
        ) : (
          <TermTable
            id="search-popular"
            caption="The words visitors searched for most."
            rows={stats.popular}
            column="searches"
          />
        )}
      </section>
      <section aria-labelledby="search-none">
        <h2 id="search-none">Searches with no results</h2>
        {stats.noResults.length === 0 ? (
          <p>Every search found something.</p>
        ) : (
          <TermTable
            id="search-none"
            caption="Visitors looked for these and found nothing. A page or post about them, or the word in an existing one, would help."
            rows={stats.noResults}
            column="noResults"
          />
        )}
      </section>
    </AdminFrame>
  );
}
