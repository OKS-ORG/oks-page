// Tools > Client content (spec 11, section 8): the guided links an agency gives to clients, and the inbox of what clients sent.
// For a signed-in member who manages the site's settings.
import { isSetupDone, listCollectLinks, listInbox } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { CollectScreen } from "./collect-screen";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Client content", robots: { index: false } };

export default async function ToolsCollectPage() {
  await connection();
  const runner = getRunner();
  if (!(await isSetupDone(runner))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const links = await listCollectLinks(runner, actor, member.siteId);
  const inbox = await listInbox(runner, actor, member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="collect"
      title="Client content"
      breadcrumbs={[{ label: "Tools" }, { label: "Client content" }]}
    >
      <CollectScreen links={links} inbox={inbox} />
    </AdminFrame>
  );
}
