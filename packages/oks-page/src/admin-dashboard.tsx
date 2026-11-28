"use client";
// The dashboard screen, drawn as the board shows: a welcome line with the quick buttons, the counts as four tiles, a card for what
// needs attention, one for visitors and one for the latest edits, inside the admin frame.
import { Card, CardBody, CardHeader } from "oks-ui";
import type { ReactNode } from "react";
import { AdminFrame } from "./admin-frame";
import type { NavItem } from "./admin-nav";
import type { DashboardData } from "./dashboard-data";
import { formatWhen } from "./time-format";

export interface AdminDashboardProps {
  user: { name: string; email: string };
  nav: NavItem[];
  data: DashboardData;
  product: string;
  version: string;
  /** True for people who may manage the settings (they get the "Set up email" note). */
  canManageSettings?: boolean;
  /** "Healthy" or "3 things need attention" (Site health), for people who manage the settings. */
  healthLine?: string | null;
}

const TILES: { label: string; key: "pages" | "posts" | "drafts" | "waiting"; d: string }[] = [
  { label: "Pages", key: "pages", d: "M6 3h9l4 4v14H6z M14 3v5h5" },
  { label: "Posts", key: "posts", d: "M4 5h16M4 10h16M4 15h10M4 20h7" },
  { label: "Drafts", key: "drafts", d: "M4 20l4-1 11-11-3-3L5 16z" },
  {
    label: "Waiting for review",
    key: "waiting",
    d: "M12 7v5l3 2 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  },
];

const CHIP: Record<string, string> = {
  published: "published",
  draft: "draft",
  scheduled: "scheduled",
  pending: "scheduled",
};

function Tile({ d, label, value }: { d: string; label: string; value: number }) {
  return (
    <div className="oks-stat">
      <dt>
        <span className="oks-stat-icon" aria-hidden="true">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={d} />
          </svg>
        </span>
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

export function AdminDashboard({
  user,
  nav,
  data,
  product,
  version,
  canManageSettings = false,
  healthLine = null,
}: AdminDashboardProps) {
  const notes: ReactNode[] = [];
  if (canManageSettings && !data.emailWorks)
    notes.push(
      <p role="note" key="email">
        Email is not set up: password reset and invitations by email are off.{" "}
        <a href="/admin/settings/email">Set up email</a>
      </p>,
    );
  if (canManageSettings && data.emailProblem)
    notes.push(
      <p role="note" key="problem">
        <strong>Emails are not going out.</strong> {data.emailProblem}{" "}
        <a href="/admin/settings/email">Open the email settings</a>
      </p>,
    );
  if (canManageSettings && data.blockedStyles.length > 0)
    notes.push(
      <p role="note" key="styles">
        <strong>A stylesheet was blocked on a public page.</strong> Visitors' browsers refused to
        load styles from {data.blockedStyles.slice(0, 3).join(", ")}
        {data.blockedStyles.length > 3 ? ` and ${data.blockedStyles.length - 3} more` : ""}. If you
        trust {data.blockedStyles.length === 1 ? "that host" : "those hosts"}, you can allow{" "}
        {data.blockedStyles.length === 1 ? "it" : "them"}.{" "}
        <a href="/admin/settings/security">Open the security settings</a>
      </p>,
    );
  const first = user.name.split(" ")[0] ?? user.name;
  // The buttons are only for the places this person may use.
  const has = (key: string) => nav.some((n) => n.key === key);
  return (
    <AdminFrame
      user={user}
      nav={nav}
      product={product}
      version={version}
      selectedKey="home"
      title="Home"
      breadcrumbs={[{ label: data.siteName }]}
    >
      <div className="oks-list-head">
        <p className="oks-list-summary">
          {`Welcome back, ${first}.`}
          {notes.length > 0 || (canManageSettings && healthLine && healthLine !== "Healthy")
            ? " Something needs you below."
            : " Everything is running well."}
        </p>
        <div className="oks-list-actions">
          {has("posts") ? (
            <a className="oks-link-button oks-link-main" href="/admin/posts">
              New post
            </a>
          ) : null}
          {has("pages") ? (
            <a className="oks-link-button" href="/admin/pages">
              New page
            </a>
          ) : null}
          {has("media") ? (
            <a className="oks-link-button" href="/admin/media">
              Upload media
            </a>
          ) : null}
        </div>
      </div>
      <Card>
        <CardHeader>{data.siteName}</CardHeader>
        <CardBody>
          <dl aria-label="Your content" className="oks-stats">
            {TILES.map((t) => (
              <Tile key={t.key} d={t.d} label={t.label} value={data.counts[t.key]} />
            ))}
          </dl>
        </CardBody>
      </Card>
      <div className="oks-dash-grid">
        {notes.length > 0 || (canManageSettings && healthLine) ? (
          <Card>
            <CardHeader>Needs attention</CardHeader>
            <CardBody>
              {notes}
              {canManageSettings && healthLine ? (
                <p data-health-line="">
                  {healthLine}. <a href="/admin/tools/health">Open Site health</a>
                </p>
              ) : null}
            </CardBody>
          </Card>
        ) : null}
        {canManageSettings && data.visits ? (
          <Card>
            <CardHeader>Visitors, last 7 days</CardHeader>
            <CardBody>
              <p>
                {data.visits.visitors} visitor{data.visits.visitors === 1 ? "" : "s"} (added up over
                the days) and {data.visits.views} page view{data.visits.views === 1 ? "" : "s"}.{" "}
                <a href="/admin/tools/statistics">Open Statistics</a>
              </p>
            </CardBody>
          </Card>
        ) : null}
      </div>
      <Card>
        <CardHeader>Recent edits</CardHeader>
        <CardBody>
          {data.recent.length === 0 ? (
            <p>Nothing has been edited yet.</p>
          ) : (
            <ul aria-label="Recent edits" className="oks-recent">
              {data.recent.map((entry) => (
                <li key={entry.id}>
                  <a
                    className="oks-list-title"
                    href={`/admin/${entry.type === "post" ? "posts" : "pages"}/${entry.id}`}
                  >
                    {entry.title}
                  </a>
                  <span className="oks-list-path">{entry.type}</span>
                  <span className="oks-chip" data-status={CHIP[entry.status] ?? "scheduled"}>
                    {entry.status}
                  </span>
                  <span className="oks-recent-when">
                    {formatWhen(entry.updatedAt, data.timeZone)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </AdminFrame>
  );
}
