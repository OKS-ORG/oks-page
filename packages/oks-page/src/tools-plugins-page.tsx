// Tools > Plugins, for a signed-in member who may manage plugins.
import { isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { listPlugins } from "./plugin-admin";
import { PluginsScreen } from "./plugins-screen";
import { pluginHost } from "./plugin-runtime";

export const metadata: Metadata = { title: "Plugins", robots: { index: false } };

export default async function PluginsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("plugins.manage")) redirect("/admin");
  // The note about the memory limit belongs to the host; when the host cannot start here the screen still opens.
  let limitsNote: string | null;
  let status: ((id: string) => string) | undefined;
  try {
    const host = await pluginHost();
    limitsNote = host.limitsNote();
    status = (id) => host.status(id);
  } catch {
    limitsNote = "The plugin sandbox could not start on this computer, so plugins are not running.";
  }
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="plugins"
      title="Plugins"
      breadcrumbs={[{ label: "Tools" }, { label: "Plugins" }]}
    >
      <PluginsScreen
        initial={await listPlugins(getRunner(), member.siteId, status)}
        limitsNote={limitsNote}
      />
    </AdminFrame>
  );
}
