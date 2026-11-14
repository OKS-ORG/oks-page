// Settings > Email > Email texts (spec 13, section 6), for a signed-in member who may manage the settings.
import { emailWorks, isSetupDone, listEmailTexts } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { EmailTextsScreen } from "./email-texts-screen";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Email texts", robots: { index: false } };

export default async function EmailTextsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const texts = await listEmailTexts(getRunner(), actor, member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Email texts"
      breadcrumbs={[
        { label: "Settings" },
        { label: "Email", href: "/admin/settings/email" },
        { label: "Email texts" },
      ]}
    >
      <SettingsLinks current="email" />
      <EmailTextsScreen
        initial={texts.ok ? texts.texts : []}
        emailWorks={await emailWorks(getRunner(), member.siteId)}
        you={member.user.email}
      />
    </AdminFrame>
  );
}
