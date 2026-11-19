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
}

export function AdminDashboard({
  user,
  nav,
  data,
  product,
  version,
  canManageSettings = false,
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
