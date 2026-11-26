"use client";
// The dashboard screen: the site's counts and its latest edits, inside the admin frame.
import { Card, CardBody, CardHeader } from "oks-ui";
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

export function AdminDashboard({
  user,
  nav,
  data,
  product,
  version,
  canManageSettings = false,
  healthLine = null,
}: AdminDashboardProps) {
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
      {canManageSettings && !data.emailWorks ? (
        <p role="note">
          Email is not set up: password reset and invitations by email are off.{" "}
          <a href="/admin/settings/email">Set up email</a>
        </p>
      ) : null}
      {canManageSettings && data.emailProblem ? (
        <p role="note">
          <strong>Emails are not going out.</strong> {data.emailProblem}{" "}
          <a href="/admin/settings/email">Open the email settings</a>
        </p>
      ) : null}
      {canManageSettings && data.blockedStyles.length > 0 ? (
        <p role="note">
          <strong>A stylesheet was blocked on a public page.</strong> Visitors' browsers refused to
          load styles from {data.blockedStyles.slice(0, 3).join(", ")}
          {data.blockedStyles.length > 3 ? ` and ${data.blockedStyles.length - 3} more` : ""}. If
          you trust {data.blockedStyles.length === 1 ? "that host" : "those hosts"}, you can allow{" "}
          {data.blockedStyles.length === 1 ? "it" : "them"}.{" "}
          <a href="/admin/settings/security">Open the security settings</a>
        </p>
      ) : null}
      {canManageSettings && healthLine ? (
        <Card>
          <CardHeader>Site health</CardHeader>
          <CardBody>
            <p data-health-line="">
              {healthLine}. <a href="/admin/tools/health">Open Site health</a>
            </p>
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader>{data.siteName}</CardHeader>
        <CardBody>
          <dl aria-label="Your content">
            <dt>Pages</dt>
            <dd>{data.counts.pages}</dd>
            <dt>Posts</dt>
            <dd>{data.counts.posts}</dd>
            <dt>Drafts</dt>
            <dd>{data.counts.drafts}</dd>
            <dt>Waiting for review</dt>
            <dd>{data.counts.waiting}</dd>
          </dl>
        </CardBody>
      </Card>
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
      <Card>
        <CardHeader>Recent edits</CardHeader>
        <CardBody>
          {data.recent.length === 0 ? (
            <p>Nothing has been edited yet.</p>
          ) : (
            <ul aria-label="Recent edits">
              {data.recent.map((entry) => (
                <li key={entry.id}>
                  <a href={`/admin/${entry.type === "post" ? "posts" : "pages"}/${entry.id}`}>
                    {entry.title}
                  </a>{" "}
                  ({entry.type}, {entry.status}) · {formatWhen(entry.updatedAt, data.timeZone)}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </AdminFrame>
  );
}
