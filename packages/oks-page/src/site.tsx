import { getPublishedEntry, getSiteInfo, getSiteMenu, getTermArchive, slugOf } from "@data";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardBody } from "oks-ui/card";
import { ArchiveView } from "./archive-view";
import { EntryJsonLd, archiveMetadata, entryMetadata } from "./page-meta";
import { PublicFrame } from "./public-frame";

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = slugOf((await params).slug);
  const entry = await getPublishedEntry(slug);
  if (entry) return entryMetadata(entry, await getSiteInfo(), { feeds: true });
  const archive = await getTermArchive(slug);
  return archive ? archiveMetadata(archive, slug, await getSiteInfo(), { feeds: true }) : {};
}

export default async function Page({ params }: Props) {
  const slug = slugOf((await params).slug);
  const entry = await getPublishedEntry(slug);
  if (!entry) {
    // An address that is not an entry may be a category or tag archive ("category/travel").
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
      <main>
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
