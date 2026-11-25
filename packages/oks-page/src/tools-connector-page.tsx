// Tools > Connection (spec 11, section 6): lets an agency's dashboard see this site's status. The site makes a connection code, shown
// once, that the agency pastes into its dashboard. For a signed-in member who manages the site's settings.
import { isSetupDone, listConnectorKeys } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { ConnectorScreen } from "./connector-screen";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Connection", robots: { index: false } };

export default async function ToolsConnectorPage() {
  await connection();
  const runner = getRunner();
  if (!(await isSetupDone(runner))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const keys = await listConnectorKeys(runner, actor, member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="connector"
      title="Connection"
      breadcrumbs={[{ label: "Tools" }, { label: "Connection" }]}
    >
      <ConnectorScreen keys={keys} />
    </AdminFrame>
  );
}
