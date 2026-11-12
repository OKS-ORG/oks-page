// The page for the export build (static mode): the same output as the server build's page, plus the list of pages to
// write. Used in place of app/[[...slug]]/page.tsx by scripts/build-export.mjs.
import {
  allSlugParams,
  getPublishedEntry,
  getSiteMenu,
  getTermArchive,
  slugOf,
} from "./data/export";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardBody } from "oks-ui/card";
import { ArchiveView, archiveTitle } from "./archive-view";
import { PublicFrame } from "./public-frame";
import { canonicalFor } from "./site-url";

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateStaticParams() {
  return allSlugParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = slugOf((await params).slug);
  const entry = await getPublishedEntry(slug);
  if (entry) return { title: entry.title, alternates: { canonical: canonicalFor(slug) } };
  const archive = await getTermArchive(slug);
  return archive
    ? { title: archiveTitle(archive), alternates: { canonical: canonicalFor(slug) } }
    : {};
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
  const [header, footer] = await Promise.all([getSiteMenu("primary"), getSiteMenu("footer")]);
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
    </PublicFrame>
  );
}
