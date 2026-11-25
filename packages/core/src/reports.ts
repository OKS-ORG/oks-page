// Client reports (spec 11, section 3: part of the Agency tier). A report is what the agency shows a client about the client's own site:
// how many people came, which pages they read, whether the site is looked after. It is made from what the connector says (see
// connector.ts), on the agency's dashboard, for the last 7, 30 or 90 days, and can be read on a page that prints well or sent by
// email. It holds counts and the state of the site's checks, never a person, a page's text or a secret.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import type { ConnectorReport, ConnectorStatus } from "./connector.js";
import { queueEmail } from "./email.js";
import type { SiteSecrets } from "./secret-box.js";
import {
  callSite,
  cleanStatus,
  fetchSiteReport,
  openAgencySite,
  type AgencyContext,
} from "./agency.js";

/** A name as one plain line: control characters (new lines among them) become spaces, and it is cut to size. */
const oneLine = (value: string, max: number): string =>
  Array.from(value, (c) => (c < " " || c === "\u007f" ? " " : c))
    .join("")
    .trim()
    .slice(0, max);

export interface ClientReport {
  siteName: string;
  siteUrl: string;
  days: number;
  /** The first and last day the counts cover (YYYY-MM-DD). */
  from: string;
  to: string;
  generatedAt: number;
  views: number;
  visitors: number;
  publishedPages: number;
  topPages: { key: string; count: number }[];
  perDay: { day: string; views: number; visitors: number }[];
  /** The state of the site, when the site could say (null: it could not be asked just now). */
  health: { version: string; checks: { label: string; ok: boolean }[] } | null;
  /** Who made the report: the agency's own name. */
  preparedBy: string;
}

type Fail = { ok: false; code: "forbidden" | "invalid" | "not_found"; message: string };

/** Asks a connected site for its counts and its state, and puts them in one report. The state is left out when it cannot be had. */
export async function buildClientReport(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  id: string,
  days: number,
  ctx: AgencyContext,
  preparedBy: string,
): Promise<{ ok: true; report: ClientReport } | Fail> {
  const counts = await fetchSiteReport(runner, actor, siteId, secrets, id, ctx, days);
  if (!counts.ok) return counts;
  const opened = await openAgencySite(runner, siteId, secrets, id);
  if (!opened.ok) return opened;
  const asked = await callSite<unknown>(opened, "/api/oks/v1/status", ctx);
  const status: ConnectorStatus | null = asked.ok ? cleanStatus(asked.data) : null;
  const r: ConnectorReport = counts.report;
  const last = r.perDay[r.perDay.length - 1]?.day ?? new Date(ctx.now()).toISOString().slice(0, 10);
  const first = r.perDay[0]?.day ?? last;
  return {
    ok: true,
    report: {
      siteName: status?.siteName || opened.name,
      siteUrl: opened.url,
      days,
      from: first,
      to: last,
      generatedAt: ctx.now(),
      views: r.views,
      visitors: r.visitors,
      publishedPages: r.publishedPages,
      topPages: r.topPages,
      perDay: r.perDay,
      health: status
        ? {
            version: status.version,
            checks: status.checks.map((c) => ({ label: c.label, ok: c.ok })),
          }
        : null,
      preparedBy: oneLine(preparedBy, 80),
    },
  };
}

const number = (n: number) => n.toLocaleString("en");

/** The report as plain text, for an email (no markup, and nothing a site said can change its layout). */
export function reportText(report: ClientReport, note = ""): string {
  const lines = [
    `Report for ${report.siteName}`,
    report.siteUrl,
    `From ${report.from} to ${report.to} (${report.days} days)`,
    "",
  ];
  if (note.trim()) lines.push(note.trim(), "");
  lines.push(
    "Visits",
    `  Page views: ${number(report.views)}`,
    `  Visitors: ${number(report.visitors)} (a person who came on two days counts twice, because nobody is followed from day to day)`,
    "",
  );
  if (report.topPages.length > 0) {
    lines.push("The most read pages");
    report.topPages.forEach((p, i) =>
      lines.push(`  ${i + 1}. ${p.key || "/"}: ${number(p.count)}`),
    );
    lines.push("");
  }
  lines.push("The site", `  Published pages: ${number(report.publishedPages)}`);
  if (report.health) {
    if (report.health.version) lines.push(`  Software version: ${report.health.version}`);
    for (const c of report.health.checks)
      lines.push(`  ${c.ok ? "Fine" : "Needs a look"}: ${c.label}`);
  }
  lines.push("", "--", report.preparedBy || "Your site team");
  return lines.join("\n");
}

const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
/** At most this many reports to one address in an hour. */
export const REPORT_EMAILS_PER_HOUR = 3;

/** Sends a report to the client's address from this site's own email. Only for people who manage the settings, with an Agency key. */
export async function emailClientReport(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  secrets: SiteSecrets,
  input: { id: string; days: number; to: unknown; note?: unknown },
  ctx: AgencyContext,
  preparedBy: string,
): Promise<{ ok: true } | Fail> {
  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (!ADDRESS.test(to) || to.length > 200)
    return { ok: false, code: "invalid", message: "Write the client's email address." };
  const note =
    typeof input.note === "string"
      ? // eslint-disable-next-line no-control-regex
        input.note.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim()
      : "";
  if (note.length > 1000)
    return { ok: false, code: "invalid", message: "The note can be at most 1,000 characters." };
  const built = await buildClientReport(
    runner,
    actor,
    siteId,
    secrets,
    input.id,
    input.days,
    ctx,
    preparedBy,
  );
  if (!built.ok) return built;
  const recent = await runner.all(
    `select count(*) as n from "email_log" where "site_id" = ? and "email_key" = 'client-report' and lower("to_address") = ? and "created_at" >= ?`,
    [siteId, to.toLowerCase(), new Date(ctx.now() - 60 * 60 * 1000)],
  );
  if (Number(recent[0]?.["n"] ?? 0) >= REPORT_EMAILS_PER_HOUR)
    return {
      ok: false,
      code: "invalid",
      message: "Three reports went to this address in the last hour. Try again later.",
    };
  const r = built.report;
  const queued = await queueEmail(
    runner,
    siteId,
    secrets,
    {
      key: "client-report",
      to,
      subject: `Report for ${r.siteName}: ${r.from} to ${r.to}`,
      text: reportText(r, note),
    },
    ctx.now,
  );
  if (!queued.queued) return { ok: false, code: "invalid", message: queued.reason };
  return { ok: true };
}
