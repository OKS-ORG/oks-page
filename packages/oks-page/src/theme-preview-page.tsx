// /admin/themes/[id]/preview: "Try with my content" (spec 05, section 17.3). The site's real pages drawn with an installed
// theme, on a desktop, tablet or phone width, without using the theme. Leaving changes nothing.
import { isSetupDone, listThemes } from "@oks-page/core";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { ThemePreviewScreen } from "./theme-preview-screen";

export const metadata: Metadata = { title: "Try a theme", robots: { index: false } };

type Props = { params: Promise<{ id: string }> };

export default async function ThemePreviewPage({ params }: Props) {
  await connection();
  const { id } = await params;
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("themes.manage")) redirect("/admin");
  const theme = (await listThemes(getRunner(), member.siteId)).find((t) => t.id === id);
  if (!theme) notFound();
  const pages = (
    await getRunner().all(
      `select "slug", "title", "type_key" from "entries" where "site_id" = ? and "status" = 'published' and "locale" = '' and "type_key" in ('page', 'post')
        order by case when "type_key" = 'page' then 0 else 1 end, "updated_at" desc limit 30`,
      [member.siteId],
    )
  ).map((r) => ({
    slug: String(r["slug"]),
    title: String(r["title"]),
    post: r["type_key"] === "post",
  }));
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title={`Try ${theme.name}`}
      breadcrumbs={[
        { label: "Settings" },
        { label: "Themes", href: "/admin/settings/themes" },
        { label: "Try" },
      ]}
    >
      <ThemePreviewScreen
        themeId={theme.id}
        themeName={theme.name}
        isActive={theme.isActive}
        pages={pages}
      />
    </AdminFrame>
  );
}
