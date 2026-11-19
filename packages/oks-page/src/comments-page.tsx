// /admin/comments, for a signed-in member who may moderate comments.
import { commentsEnabled, isSetupDone, listComments } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { CommentsScreen } from "./comments-screen";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Comments", robots: { index: false } };

export default async function CommentsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  const listed = await listComments(getRunner(), actor, member.siteId, "pending");
  if (!listed.ok) redirect("/admin");
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="comments"
      title="Comments"
      breadcrumbs={[{ label: "Comments" }]}
    >
      <CommentsScreen
        initialEnabled={await commentsEnabled(getRunner(), member.siteId)}
        initial={{ comments: listed.comments, counts: listed.counts }}
        canSwitch={actor.can("settings.manage")}
      />
    </AdminFrame>
  );
}
