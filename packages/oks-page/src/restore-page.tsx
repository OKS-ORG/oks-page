// /admin/restore/<token>: the link in the email about a client's change to a live page (decision D60). It shows what would change and has
// one button; opening the link changes nothing. For people who may publish; anyone else, or nobody signed in, is led away.
import { describeClientEdit, isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { siteSecrets } from "./mail";
import { RestoreScreen } from "./restore-screen";

export const metadata: Metadata = {
  title: "Put the earlier version back",
  robots: { index: false },
  referrer: "no-referrer",
};

export default async function RestorePage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const runner = getRunner();
  if (!(await isSetupDone(runner))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("content.publish_any")) redirect("/admin");
  const { token } = await params;
  const described = await describeClientEdit(runner, actor, member.siteId, siteSecrets(), token);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="pages"
      title="Put the earlier version back"
      breadcrumbs={[
        { label: "Pages", href: "/admin/pages" },
        { label: "Put the earlier version back" },
      ]}
    >
      {described.ok ? (
        <RestoreScreen token={token} view={described.view} />
      ) : (
        <p role="alert">{described.message}</p>
      )}
    </AdminFrame>
  );
}
