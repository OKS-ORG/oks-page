// Settings > Themes, for a signed-in member who may change the design: upload a theme file and read its report, use a
// theme, go back to the version before, remove one, or go back to the built-in design.
import { isSetupDone, listThemes } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { SettingsLinks } from "./settings-links";
import { ThemesScreen } from "./themes-screen";

export const metadata: Metadata = { title: "Themes", robots: { index: false } };

export default async function ThemesSettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("themes.manage")) redirect("/admin");
  const themes = await listThemes(getRunner(), member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Themes"
      breadcrumbs={[{ label: "Settings" }, { label: "Themes" }]}
    >
      <SettingsLinks current="themes" />
      <ThemesScreen initial={themes} />
    </AdminFrame>
  );
}
