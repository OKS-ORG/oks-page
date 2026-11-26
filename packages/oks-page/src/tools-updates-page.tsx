// Tools > Updates (spec 14, part 1): the core and the plugins with the version in use and the newest one, and the security
// warnings that name something this site runs. For a signed-in member who manages the site's settings.
import { isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { currentUpdateView, updateUrl } from "./updates-context";
import { UpdatesScreen } from "./updates-screen";

export const metadata: Metadata = { title: "Updates", robots: { index: false } };

export default async function ToolsUpdatesPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const view = await currentUpdateView(getRunner(), member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="updates"
      title="Updates"
      breadcrumbs={[{ label: "Tools" }, { label: "Updates" }]}
    >
      <UpdatesScreen view={view} hasServer={updateUrl() !== undefined} />
    </AdminFrame>
  );
}
