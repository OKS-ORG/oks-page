// /admin/users: the people of the site, their roles and the waiting invitations, for a signed-in member who may manage users.
import {
  isSetupDone,
  listInvitations,
  listMembers,
  listRoles,
  loadGeneralSettings,
} from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { UsersScreen } from "./users-screen";

export const metadata: Metadata = { title: "Users", robots: { index: false } };

export default async function UsersPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("users.manage")) redirect("/admin");
  const runner = getRunner();
  const [members, roles, invitations, general] = await Promise.all([
    listMembers(runner, member.siteId),
    listRoles(runner, member.siteId),
    listInvitations(runner, member.siteId),
    loadGeneralSettings(runner, member.siteId),
  ]);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="users"
      title="Users"
      breadcrumbs={[{ label: "Users" }]}
    >
      <UsersScreen
        you={member.user.id}
        members={members}
        roles={roles}
        invitations={invitations}
        timeZone={general.timeZone}
      />
    </AdminFrame>
  );
}
