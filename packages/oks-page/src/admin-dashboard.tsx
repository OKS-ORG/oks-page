"use client";
// The dashboard screen: the admin shell around the site's counts and its latest edits.
import { Shell } from "@oks-page/admin";
import "@oks-page/admin/shell.css";
import { Button, Card, CardBody, CardHeader } from "oks-ui";
import type { DashboardData } from "./dashboard-data";

export interface AdminDashboardProps {
  user: { name: string; email: string };
  data: DashboardData;
  product: string;
  version: string;
}

const NAV = [{ key: "home", label: "Home", href: "/admin" }];

async function signOut() {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  window.location.assign("/admin/login");
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

export function AdminDashboard({ user, data, product, version }: AdminDashboardProps) {
  return (
    <Shell
      nav={NAV}
      selectedKey="home"
      title="Home"
      breadcrumbs={[{ label: data.siteName }]}
      footer={{ product, version }}
    >
      <p>
        Signed in as {user.name} ({user.email}){" "}
        <Button onPress={() => void signOut()}>Sign out</Button>
      </p>
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
                <li key={`${entry.type}-${entry.title}-${entry.updatedAt}`}>
                  {entry.title} ({entry.type}, {entry.status}) · {when(entry.updatedAt)}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </Shell>
  );
}
