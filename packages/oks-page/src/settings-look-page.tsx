// Settings > Look, for a signed-in member who may manage the settings: the main color, the fonts and the logo.
import { isSetupDone, loadContrastWarnings, loadThemeStyles } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { LookForm, type LogoPreview } from "./look-form";
import { SettingsLinks } from "./settings-links";
import { mediaContext } from "./uploads";

export const metadata: Metadata = { title: "Look of the site", robots: { index: false } };

export default async function LookSettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const styles = await loadThemeStyles(getRunner(), member.siteId);
  const warnings = await loadContrastWarnings(getRunner(), member.siteId);
  let logo: LogoPreview | null = null;
  if (styles.logoMediaId) {
    const found = await getRunner().all(
      `select "storage_key", "alt" from "media" where "site_id" = ? and "id" = ?`,
      [member.siteId, styles.logoMediaId],
    );
    if (found[0])
      logo = {
        url: mediaContext().storage.publicUrl(String(found[0]["storage_key"])),
        alt: String(found[0]["alt"]),
      };
  }
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Look of the site"
      breadcrumbs={[{ label: "Settings" }, { label: "Look" }]}
    >
      <SettingsLinks current="look" />
      <LookForm initial={styles} logo={logo} warnings={warnings} />
    </AdminFrame>
  );
}
