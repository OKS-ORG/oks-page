// /admin/themes/[id]/preview/frame: one published page of the site drawn with an installed theme and its layouts, whether
// or not the theme is in use (spec 05, sections 9 and 17.3). For a signed-in member who may change the design; anyone
// else gets a plain "not found". Never cached and never indexed. Nothing is changed on the site.
import { layoutCandidates, loadThemeLayouts, loadThemeVersion, pickLayout } from "@oks-page/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Card, CardBody } from "oks-ui/card";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { loadLook, loadPublishedEntry, loadSiteMenu } from "./data/entries";
import { getRunner } from "./db";
import { PublicFrame } from "./public-frame";
import { ThemedPage } from "./theme-layout";

export const metadata: Metadata = {
  title: "Theme preview",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> };

/** The page shown when none is asked for: the home page, else the newest published page, else the newest post. */
async function defaultSlug(siteId: string): Promise<string | null> {
  const rows = await getRunner().all(
    `select "slug" from "entries" where "site_id" = ? and "status" = 'published' and "locale" = '' and "type_key" in ('page', 'post')
      order by case when "slug" = 'home' then 0 when "type_key" = 'page' then 1 else 2 end, "updated_at" desc limit 1`,
    [siteId],
  );
  return rows[0] ? String(rows[0]["slug"]) : null;
}

export default async function ThemePreviewFramePage({ params, searchParams }: Props) {
  await connection();
  const { id } = await params;
  const { page } = await searchParams;
  const member = await signedInMember();
  if (!member) notFound();
  if (!(await actorOf(member)).can("themes.manage")) notFound();
  const runner = getRunner();
  const siteId = member.siteId;
  if (!(await loadThemeVersion(runner, siteId, id))) notFound();
  const [look, header, footer, layouts] = await Promise.all([
    loadLook(id),
    loadSiteMenu("primary"),
    loadSiteMenu("footer"),
    loadThemeLayouts(runner, siteId, { themeId: id }),
  ]);
  const slug = typeof page === "string" && page ? page : await defaultSlug(siteId);
  const entry = slug ? await loadPublishedEntry(slug) : null;
  if (!entry)
    return (
      <PublicFrame header={header} footer={footer} look={look}>
        <main>
          <h1>Nothing to show yet</h1>
          <p>Publish a page or a post, then look here again.</p>
        </main>
      </PublicFrame>
    );
  const layout = pickLayout(
    layouts,
    layoutCandidates({ kind: "entry", type: entry.type, slug: entry.slug, chosen: entry.layout }),
  );
  if (layout && layouts)
    return (
      <ThemedPage
        layout={layout}
        parts={layouts.parts}
        look={look}
        page={{
          title: entry.title,
          content: <article dangerouslySetInnerHTML={{ __html: entry.html }} />,
          meta: null,
          isFront: entry.slug === "home",
        }}
      />
    );
  return (
    <PublicFrame header={header} footer={footer} look={look}>
      <main>
        <h1>{entry.title}</h1>
        <Card>
          <CardBody>
            <article dangerouslySetInnerHTML={{ __html: entry.html }} />
          </CardBody>
        </Card>
      </main>
    </PublicFrame>
  );
}
