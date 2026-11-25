// Tools > Backups (spec 14, part 2): the backups of the whole site, with a button to make one, to download, to restore and to delete.
// For a signed-in member who manages the site's settings.
import { dailyBackupOn, isSetupDone, listBackups, loadBackupState } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { backupContext } from "./backup-context";
import { BackupsScreen } from "./backups-screen";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Backups", robots: { index: false } };

export default async function ToolsBackupsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const backups = await listBackups(backupContext(), actor);
  const daily = await dailyBackupOn(getRunner(), member.siteId);
  const state = await loadBackupState(getRunner(), member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="backups"
      title="Backups"
      breadcrumbs={[{ label: "Tools" }, { label: "Backups" }]}
    >
      <BackupsScreen
        backups={backups}
        daily={daily}
        failure={state.failedAt !== null ? { at: state.failedAt, reason: state.failure } : null}
      />
    </AdminFrame>
  );
}
