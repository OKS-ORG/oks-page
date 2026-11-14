// /admin/site-editor/preview: the real site with the owner's unpublished layout changes, shown inside the site editor.
// Only for people who may change the site design; never cached and never indexed. Every block carries its id, so a click
// in the preview selects it in the editor.
//   ?theme=<id>              the theme being edited
//   &layout=templates/index  the layout being edited (a page layout is used for the page, whatever page is shown)
//   &page=entry:<address> | archive:<category/x> | search   the page that fills the preview
//   &use=draft|published|theme   for the edited layout: the draft (default), the published change, or the theme's own
import { layoutCandidates, loadThemeLayouts, pickLayout } from "@oks-page/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { ArchiveContent, archiveTitle } from "./archive-view";
import { loadPublishedEntry, loadTermArchive } from "./data/entries";
import { getRunner } from "./db";
import { ThemedPage, type ThemedPageInfo } from "./theme-layout";

export const metadata: Metadata = {
  title: "Site editor preview",
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<{ theme?: string; layout?: string; page?: string; use?: string }>;
};

const KEY = /^(templates|parts)\/([a-z0-9][a-z0-9-]{0,63})$/;
const one = (value: unknown) => (typeof value === "string" ? value : "");

// The outline of the block under the pointer and of the selected block (the editor marks it with data-selected).
const EDITOR_CSS = `
.oks-editor-block{position:relative}
.oks-editor-block:hover{outline:1px dashed #6b7280;outline-offset:2px;cursor:pointer}
.oks-editor-block[data-selected]{outline:2px solid #2563eb;outline-offset:2px}
.oks-editor-empty{opacity:.7;font-style:italic}
`;

export default async function SiteEditorPreview({ searchParams }: Props) {
  await connection();
  const member = await signedInMember();
  if (!member || !(await actorOf(member)).can("themes.manage")) notFound();
  const params = await searchParams;
  const themeId = one(params.theme);
  const key = one(params.layout);
  const use = params.use === "theme" || params.use === "published" ? params.use : "draft";
  const layouts = await loadThemeLayouts(getRunner(), member.siteId, {
    themeId,
    drafts: true,
    split: true,
    ...(KEY.test(key) ? { only: { key, use } } : {}),
  });
  if (!layouts) notFound();

  // The page that fills the preview.
  const pageParam = one(params.page) || "entry:home";
  let info: ThemedPageInfo;
  let candidates: string[];
  if (pageParam === "search") {
    info = {
      title: "Search",
      content: <p>Search results show here.</p>,
      meta: null,
      isFront: false,
    };
    candidates = layoutCandidates({ kind: "search" });
  } else if (pageParam.startsWith("archive:")) {
    const archive = await loadTermArchive(pageParam.slice("archive:".length));
    if (!archive) notFound();
    info = {
      title: archiveTitle(archive),
      content: <ArchiveContent archive={archive} />,
      meta: null,
      isFront: false,
    };
    candidates = layoutCandidates({ kind: "archive", termKind: archive.kind });
  } else {
    const slug = pageParam.startsWith("entry:") ? pageParam.slice("entry:".length) : "home";
    const entry = await loadPublishedEntry(slug);
    if (!entry) notFound();
    info = {
      title: entry.title,
      content: <article dangerouslySetInnerHTML={{ __html: entry.html }} />,
      meta:
        entry.type === "post"
          ? { publishedAt: entry.publishedAt, authorName: entry.authorName }
          : null,
      isFront: slug === "home",
    };
    candidates = layoutCandidates({ kind: "entry", type: entry.type, slug });
  }
  // A page layout being edited is used for the page shown, so the owner sees it whatever page fills the preview.
  const match = KEY.exec(key);
  const forced =
    match?.[1] === "templates" && Object.hasOwn(layouts.templates, match[2]!)
      ? layouts.templates[match[2]!]!
      : null;
  const layout = forced ?? pickLayout(layouts, candidates);
  if (!layout) notFound();
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: EDITOR_CSS }} />
      <ThemedPage layout={layout} parts={layouts.parts} page={info} editor />
    </>
  );
}
