// /admin/account: your own account for any signed-in member (two-factor sign-in for now).
import { isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { AccountScreen } from "./account-screen";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Your account", robots: { index: false } };

export default async function AccountPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  const row = (
    await getRunner().all(`select "two_factor_enabled" from "users" where "id" = ?`, [
      member.user.id,
    ])
  )[0];
  const enabled = row?.["two_factor_enabled"] === true || Number(row?.["two_factor_enabled"]) === 1;
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="account"
      title="Your account"
      breadcrumbs={[{ label: "Your account" }]}
    >
      <AccountScreen initialEnabled={enabled} />
    </AdminFrame>
  );
}
