// Settings > Content types, for a signed-in member who may manage content types.
import { isSetupDone, listContentTypes } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { ContentTypesScreen } from "./content-types-screen";
import { getRunner } from "./db";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Content types", robots: { index: false } };

export default async function ContentTypesSettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("content_types.manage")) redirect("/admin");
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Content types"
      breadcrumbs={[{ label: "Settings" }, { label: "Content types" }]}
    >
      <SettingsLinks current="content-types" />
      <ContentTypesScreen initial={await listContentTypes(getRunner(), member.siteId)} />
    </AdminFrame>
  );
}
