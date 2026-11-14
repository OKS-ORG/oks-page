// /admin/site-editor/preview: the real site with the owner's unpublished layout changes, shown inside the site editor.
// Only for people who may change the site design; never cached and never indexed. Every block carries its id, so a click
// in the preview selects it in the editor.
//   ?theme=<id>              the theme being edited
//   &layout=templates/index  the layout being edited (a page layout is used for the page, whatever page is shown)
//   &page=entry:<address> | archive:<category/x> | search   the page that fills the preview
//   &use=draft|published|theme   for the edited layout: the draft (default), the published change, or the theme's own
//   &section=<name>          only one ready-made section of the theme, for its picture in the section library
//   &saved=<id>              only one saved section: its picture (&picture=1), or the editor's preview of it (with
//                            its draft unless &use=published)
import {
  checkedDrawNodes,
  layoutCandidates,
  loadSectionBlocks,
  loadThemeLayouts,
  loadThemeVersion,
  pickLayout,
  toDrawNodes,
} from "@oks-page/core";
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
  searchParams: Promise<{
    theme?: string;
    layout?: string;
    page?: string;
    use?: string;
    section?: string;
    saved?: string;
    picture?: string;
  }>;
};

const KEY = /^(templates|parts)\/([a-z0-9][a-z0-9-]{0,63})$/;
const one = (value: unknown) => (typeof value === "string" ? value : "");

// The outline of the block under the pointer and of the selected block (the editor marks it with data-selected).
const EDITOR_CSS = `
.oks-editor-block{position:relative}
.oks-editor-block:hover{outline:1px dashed #6b7280;outline-offset:2px;cursor:pointer}
.oks-editor-block[data-selected]{outline:2px solid #2563eb;outline-offset:2px}
.oks-editor-empty{opacity:.7;font-style:italic}
@media (max-width:767px){.oks-editor-hidden-phone{opacity:.35;outline:1px dashed #6b7280}}
@media (min-width:768px) and (max-width:1024px){.oks-editor-hidden-tablet{opacity:.35;outline:1px dashed #6b7280}}
@media (min-width:1025px){.oks-editor-hidden-desktop{opacity:.35;outline:1px dashed #6b7280}}
`;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export default async function SiteEditorPreview({ searchParams }: Props) {
  await connection();
  const member = await signedInMember();
  if (!member || !(await actorOf(member)).can("themes.manage")) notFound();
  const params = await searchParams;
  const themeId = one(params.theme);

  // One saved section: as a picture for the library, or with ids for the editor (its draft unless asked otherwise).
  const savedId = one(params.saved);
  if (savedId) {
    const picture = params.picture === "1";
    const sections = await loadSectionBlocks(getRunner(), member.siteId, {
      drafts: !picture && params.use !== "published",
    });
    const blocks = sections.get(savedId);
    if (!blocks) notFound();
    // Its own blocks keep their ids (a section linked inside it is one block), so a click selects them.
    const nodes = toDrawNodes(blocks, { split: true, sections });
    const page = { title: "Saved section", content: null, meta: null, isFront: false };
    if (picture)
      return (
        <div inert>
          <ThemedPage layout={nodes} parts={{}} page={page} />
        </div>
      );
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: EDITOR_CSS }} />
        <ThemedPage layout={nodes} parts={{}} page={page} editor />
      </>
    );
  }

  // One ready-made section, drawn with the site's look; nothing in it can be focused or clicked (it is a picture).
  const sectionName = one(params.section);
  if (sectionName) {
    if (!NAME.test(sectionName)) notFound();
    const found = await loadThemeVersion(getRunner(), member.siteId, themeId);
    const ready = found?.version.patterns.find((p) => p.name === sectionName);
    if (!ready) notFound();
    const nodes = checkedDrawNodes(ready.blocks);
    return (
      <div inert>
        <ThemedPage
          layout={nodes}
          parts={{}}
          page={{ title: ready.title, content: null, meta: null, isFront: false }}
        />
      </div>
    );
  }
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
    candidates = layoutCandidates({ kind: "entry", type: entry.type, slug, chosen: entry.layout });
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
