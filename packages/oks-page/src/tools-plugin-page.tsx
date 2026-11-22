// Tools > Plugins > one admin page of a plugin (spec 04, section 9), for a signed-in member who may manage plugins.
import { isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { PluginPageScreen } from "./plugin-page-screen";
import { loadPluginPage } from "./plugin-pages";

export const metadata: Metadata = { title: "Plugin page", robots: { index: false } };

export default async function ToolsPluginPage({
  params,
}: {
  params: Promise<{ plugin: string; page: string }>;
}) {
  await connection();
  const { plugin, page } = await params;
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("plugins.manage")) redirect("/admin");
  const loaded = await loadPluginPage(getRunner(), actor, member.siteId, plugin, page);
  if (!loaded.ok) notFound();
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="plugins"
      title={loaded.view.title}
      breadcrumbs={[
        { label: "Tools" },
        { label: "Plugins", href: "/admin/tools/plugins" },
        { label: loaded.view.title },
      ]}
    >
      <PluginPageScreen plugin={plugin} page={page} initial={loaded.view} />
    </AdminFrame>
  );
}
