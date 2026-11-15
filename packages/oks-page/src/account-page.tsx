// /admin/account: your own account for any signed-in member (two-factor sign-in for now).
import { emailWorks, isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { AccountEmail } from "./account-email";
import { AccountScreen } from "./account-screen";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Your account", robots: { index: false } };

type Props = { searchParams: Promise<{ email?: string; error?: string }> };

export default async function AccountPage({ searchParams }: Props) {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember({ allowSetup: true });
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  const row = (
    await getRunner().all(
      `select "two_factor_enabled", "email", "email_verified" from "users" where "id" = ?`,
      [member.user.id],
    )
  )[0];
  const verified = row?.["email_verified"] === true || Number(row?.["email_verified"]) === 1;
  const params = await searchParams;
  const enabled = row?.["two_factor_enabled"] === true || Number(row?.["two_factor_enabled"]) === 1;
  return (
    <AdminFrame
      nav={member.mustSetUpTwoFactor ? [] : navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="account"
      title="Your account"
      breadcrumbs={[{ label: "Your account" }]}
    >
      <AccountEmail
        email={String(row?.["email"] ?? member.user.email)}
        verified={verified}
        emailWorks={await emailWorks(getRunner(), member.siteId)}
        result={typeof params.email === "string" ? params.email : null}
        error={typeof params.error === "string" ? params.error : null}
      />
      <AccountScreen initialEnabled={enabled} required={member.mustSetUpTwoFactor} />
    </AdminFrame>
  );
}
