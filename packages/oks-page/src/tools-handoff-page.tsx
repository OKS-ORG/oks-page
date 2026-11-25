// Tools > Handoff (spec 11, section 9): the checklist for giving a site to a client. For a signed-in member who manages the
// site's settings.
import {
  clientNoticeOn,
  emailWorks,
  isSetupDone,
  lastGoodBackup,
  listClientEdits,
  listMembers,
  loadHandoff,
  loadPrivacySettings,
  makeRestoreToken,
} from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { backupContext } from "./backup-context";
import { getRunner } from "./db";
import { HandoffScreen } from "./handoff-screen";
import { siteSecrets } from "./mail";

export const metadata: Metadata = { title: "Handoff", robots: { index: false } };

export default async function ToolsHandoffPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const runner = getRunner();
  const admins = (await listMembers(runner, member.siteId)).filter(
    (m) => m.roleKey === "administrator",
  );
  const view = await loadHandoff(runner, member.siteId, {
    twoFactor: { on: admins.filter((a) => a.twoFactor).length, total: admins.length },
    emailWorks: await emailWorks(runner, member.siteId),
    privacyPage: (await loadPrivacySettings(runner, member.siteId)).pageId !== null,
    backup: { lastAt: (await lastGoodBackup(backupContext()))?.createdAt ?? null },
  });
  // What clients changed on live pages lately; each has a link that puts the earlier version back (for people who may publish).
  const mayRestore = actor.can("content.publish_any");
  const edits = (await listClientEdits(runner, actor, member.siteId, 10)).map((e) => ({
    entryId: e.entryId,
    title: e.title,
    client: e.client,
    at: e.at,
    restored: e.restored,
    restoreHref:
      mayRestore && e.copyId && !e.restored
        ? `/admin/restore/${makeRestoreToken(siteSecrets(), { entryId: e.entryId, copyId: e.copyId, revisionAfter: e.revisionAfter })}`
        : null,
  }));
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="handoff"
      title="Handoff"
      breadcrumbs={[{ label: "Tools" }, { label: "Handoff" }]}
    >
      <HandoffScreen
        initial={view}
        bundle={actor.can("export") && actor.can("import")}
        edits={edits}
        noticeOn={await clientNoticeOn(runner, member.siteId)}
      />
    </AdminFrame>
  );
}
