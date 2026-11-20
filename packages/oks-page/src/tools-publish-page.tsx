// Tools > Publish, for a signed-in member who may change the settings.
import { isSetupDone, listPublishTargets, loadPublishLast, publicTarget } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { PublishScreen } from "./publish-screen";
import { exportFolder, exportReady, publishRunning, zipFolder } from "./publish-runner";

export const metadata: Metadata = { title: "Publish", robots: { index: false } };

export default async function PublishPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="publish"
      title="Publish"
      breadcrumbs={[{ label: "Tools" }, { label: "Publish" }]}
    >
      <PublishScreen
        initial={{
          targets: (await listPublishTargets(getRunner(), member.siteId)).map(publicTarget),
          last: await loadPublishLast(getRunner(), member.siteId),
          running: publishRunning(),
          exportReady: exportReady(),
          exportFolder: exportFolder(),
          zipFolder: zipFolder(),
        }}
      />
    </AdminFrame>
  );
}
