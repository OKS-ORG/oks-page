// Settings > Domains (design batch 5), for a signed-in member who may manage the settings. Shows the main address of the
// site; connecting more domains comes with hosting (M7).
import { isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { SettingsLinks } from "./settings-links";

export const metadata: Metadata = { title: "Domains", robots: { index: false } };

export default async function DomainsSettingsPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("settings.manage")) redirect("/admin");
  const head = await headers();
  const set = process.env["OKS_SITE_URL"];
  const address =
    set ?? `${head.get("x-forwarded-proto") ?? "http"}://${head.get("host") ?? "localhost"}`;
  const secure = address.startsWith("https://");
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Domains"
      breadcrumbs={[{ label: "Settings" }, { label: "Domains" }]}
    >
      <SettingsLinks current="domains" />
      <section aria-labelledby="domains-main">
        <h2 id="domains-main">Main address</h2>
        <p>
          <code>{address}</code>
        </p>
        <p>
          {secure
            ? "Visitors reach your site over a secure connection."
            : "This address is not secure (no https). Before you share your site, give it an https address."}
        </p>
        <p>
          {set
            ? "The address is set where the site runs, in OKS_SITE_URL. To change it, change that setting and restart the site."
            : "No address is set where the site runs, so the address of this request is shown. Set OKS_SITE_URL to your site's address so links in emails, feeds and the sitemap use it."}
        </p>
      </section>
      <section aria-labelledby="domains-more">
        <h2 id="domains-more">More domains</h2>
        <p>
          Connecting more domains to your site, and sending them to the main address, comes in a
          later release.
        </p>
      </section>
    </AdminFrame>
  );
}
