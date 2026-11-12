"use client";
// The dashboard screen: the site's counts and its latest edits, inside the admin frame.
import { Card, CardBody, CardHeader } from "oks-ui";
import { AdminFrame } from "./admin-frame";
import type { NavItem } from "./admin-nav";
import type { DashboardData } from "./dashboard-data";

export interface AdminDashboardProps {
  user: { name: string; email: string };
  nav: NavItem[];
  data: DashboardData;
  product: string;
  version: string;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

export function AdminDashboard({ user, nav, data, product, version }: AdminDashboardProps) {
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
                  ({entry.type}, {entry.status}) · {when(entry.updatedAt)}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </AdminFrame>
  );
}
