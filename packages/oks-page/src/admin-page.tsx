// /admin: the dashboard ("Home"). Only a signed-in member of the site sees it; anyone else is sent to sign in.
import { isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { AdminDashboard } from "./admin-dashboard";
import { loadDashboard } from "./dashboard-data";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Home", robots: { index: false } };

export default async function AdminPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const me = await signedInMember();
  if (!me) redirect("/admin/login");
  const actor = await actorOf(me);
  return (
    <AdminDashboard
      user={me.user}
      nav={navFor((c) => actor.can(c))}
      data={await loadDashboard(me.siteId)}
      canManageSettings={actor.can("settings.manage")}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
    />
  );
}
