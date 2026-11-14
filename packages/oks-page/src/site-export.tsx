// The page for the export build (static mode): the same output as the server build's page, plus the list of pages to
// write. Used in place of app/[[...slug]]/page.tsx by scripts/build-export.mjs. A static export has no feeds, so the
// pages carry no feed links.
import {
  allSlugParams,
  getPublishedEntry,
  getSiteInfo,
  getSiteMenu,
  getTermArchive,
  getThemeLayouts,
  slugOf,
} from "./data/export";
import { layoutCandidates, pickLayout, type PageKind } from "@oks-page/core";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardBody } from "oks-ui/card";
import { ArchiveContent, ArchiveView, archiveTitle } from "./archive-view";
import { EntryJsonLd, archiveMetadata, entryMetadata } from "./page-meta";
import { PublicFrame } from "./public-frame";
import { ThemedPage, type ThemedPageInfo } from "./theme-layout";

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateStaticParams() {
  return allSlugParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = slugOf((await params).slug);
  const entry = await getPublishedEntry(slug);
  if (entry) return entryMetadata(entry, await getSiteInfo(), { feeds: false });
  const archive = await getTermArchive(slug);
  return archive ? archiveMetadata(archive, slug, await getSiteInfo(), { feeds: false }) : {};
}

export default async function Page({ params }: Props) {
  const slug = slugOf((await params).slug);
  const entry = await getPublishedEntry(slug);
  if (!entry) {
    const archive = await getTermArchive(slug);
    if (!archive) notFound();
    const drawn = await themed(
      { kind: "archive", termKind: archive.kind },
      {
        title: archiveTitle(archive),
        content: <ArchiveContent archive={archive} />,
        meta: null,
        isFront: false,
        pagefind: true,
      },
    );
    if (drawn) return drawn;
    const [header, footer] = await Promise.all([getSiteMenu("primary"), getSiteMenu("footer")]);
    return (
      <PublicFrame header={header} footer={footer}>
        <ArchiveView archive={archive} />
      </PublicFrame>
    );
  }
  const drawn = await themed(
    { kind: "entry", type: entry.type, slug, chosen: entry.layout },
    {
      title: entry.title,
      content: <article dangerouslySetInnerHTML={{ __html: entry.html }} />,
      meta:
        entry.type === "post"
          ? { publishedAt: entry.publishedAt, authorName: entry.authorName }
          : null,
      isFront: slug === "home",
      pagefind: true,
    },
  );
  if (drawn)
    return (
      <>
        {drawn}
        <EntryJsonLd entry={entry} site={await getSiteInfo()} />
      </>
    );
  const [header, footer, site] = await Promise.all([
    getSiteMenu("primary"),
    getSiteMenu("footer"),
    getSiteInfo(),
  ]);
  return (
    <PublicFrame header={header} footer={footer}>
      <main data-pagefind-body>
        <h1>{entry.title}</h1>
        <Card>
          <CardBody>
            <article dangerouslySetInnerHTML={{ __html: entry.html }} />
          </CardBody>
        </Card>
      </main>
      <EntryJsonLd entry={entry} site={site} />
    </PublicFrame>
  );
}

/** The page drawn from the theme's layout for it, or null when the theme has none (or no theme is in use). */
async function themed(kind: PageKind, page: ThemedPageInfo): Promise<ReactNode | null> {
  const layouts = await getThemeLayouts();
  const layout = pickLayout(layouts, layoutCandidates(kind));
  return layout && layouts ? (
    <ThemedPage layout={layout} parts={layouts.parts} page={page} />
  ) : null;
}
