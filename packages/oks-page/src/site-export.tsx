// The page for the export build (static mode): the same output as the server build's page, plus the list of pages to
// write. Used in place of app/[[...slug]]/page.tsx by scripts/build-export.mjs. A static export has no feeds, so the
// pages carry no feed links.
import {
  allSlugParams,
  getPublishedEntry,
  getSiteInfo,
  getSiteMenu,
  getTermArchive,
  slugOf,
} from "./data/export";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardBody } from "oks-ui/card";
import { ArchiveView } from "./archive-view";
import { EntryJsonLd, archiveMetadata, entryMetadata } from "./page-meta";
import { PublicFrame } from "./public-frame";

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
    const [header, footer] = await Promise.all([getSiteMenu("primary"), getSiteMenu("footer")]);
    return (
      <PublicFrame header={header} footer={footer}>
        <ArchiveView archive={archive} />
      </PublicFrame>
    );
  }
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
