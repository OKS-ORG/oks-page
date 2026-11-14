// Settings > Site editor (spec 05, section 17.5): change the layouts of the theme in use on a live preview of the real
// site. For people who may change the site design. The editor itself is a client screen; this page loads what it needs.
import {
  isSetupDone,
  listLayouts,
  listSavedSections,
  sectionPlaces,
  typesWithoutLayout,
  loadThemeVersion,
  SECTION_GROUP_LABELS,
  SECTION_GROUPS,
  sectionGroup,
} from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { SettingsLinks } from "./settings-links";
import { SiteEditor, type PreviewPage, type SavedSection } from "./site-editor";

export const metadata: Metadata = { title: "Site editor", robots: { index: false } };

export default async function SiteEditorPage() {
  await connection();
  const runner = getRunner();
  if (!(await isSetupDone(runner))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("themes.manage")) redirect("/admin");

  const active = await runner.all(
    `select "id", "key" from "themes" where "site_id" = ? and "is_active" = ? and "source" = 'runtime'`,
    [member.siteId, true],
  );
  const themeId = active[0] ? String(active[0]["id"]) : null;
  const found = themeId ? await loadThemeVersion(runner, member.siteId, themeId) : null;
  const layouts = themeId ? await listLayouts(runner, actor, member.siteId, themeId) : null;
  const savedList = await listSavedSections(runner, actor, member.siteId);
  const saved: SavedSection[] = savedList.ok
    ? await Promise.all(
        savedList.sections.map(async (s) => ({
          ...s,
          places: (await sectionPlaces(runner, member.siteId, s.id)).length,
        })),
      )
    : [];

  // The pages that can fill the preview: published pages and posts, category and tag pages, and search.
  const entries = await runner.all(
    `select "title", "slug", "type_key" from "entries"
      where "site_id" = ? and "status" = 'published' and "locale" = '' order by "type_key", "title" limit 300`,
    [member.siteId],
  );
  const terms = await runner.all(
    `select x."key", t."slug", t."name" from "terms" t join "taxonomies" x on x."id" = t."taxonomy_id"
      where x."site_id" = ? and x."key" in ('category', 'tag') order by x."key", t."name" limit 100`,
    [member.siteId],
  );
  const pages: PreviewPage[] = [
    ...entries.map((e) => ({
      value: `entry:${String(e["slug"])}`,
      label: `${String(e["type_key"]) === "post" ? "Post" : String(e["type_key"]) === "page" ? "Page" : String(e["type_key"])}: ${String(e["title"]) || "(no title)"}`,
      type: String(e["type_key"]),
      slug: String(e["slug"]),
    })),
    ...terms.map((t) => ({
      value: `archive:${String(t["key"])}/${String(t["slug"])}`,
      label: `${String(t["key"]) === "category" ? "Category" : "Tag"}: ${String(t["name"])}`,
      type: "archive",
      slug: `${String(t["key"])}/${String(t["slug"])}`,
    })),
    { value: "search", label: "Search results", type: "search", slug: "search" },
  ];

  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="settings"
      title="Site editor"
      breadcrumbs={[{ label: "Settings" }, { label: "Site editor" }]}
    >
      <SettingsLinks current="site-editor" />
      {themeId && found && layouts?.ok && layouts.layouts.length > 0 ? (
        <SiteEditor
          themeId={themeId}
          themeName={found.version.name}
          initialLayouts={layouts.layouts}
          pages={pages}
          initialSaved={saved}
          initialTypes={themeId ? await typesWithoutLayout(runner, member.siteId, themeId) : []}
          sectionGroups={SECTION_GROUPS.map((g) => ({ value: g, label: SECTION_GROUP_LABELS[g] }))}
          parts={found.version.parts.map((p) => p.name)}
          sections={found.version.patterns
            .map((p) => ({
              name: p.name,
              title: p.title,
              blocks: p.blocks,
              group: SECTION_GROUP_LABELS[sectionGroup(p.group)],
              order: SECTION_GROUPS.indexOf(sectionGroup(p.group)),
            }))
            .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))}
        />
      ) : (
        <p>
          The site editor changes the layouts of the theme in use. Your site uses the built-in
          design, or a theme without layouts. <a href="/admin/settings/themes">Choose a theme</a>.
        </p>
      )}
    </AdminFrame>
  );
}
