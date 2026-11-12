import { getPublishedEntry, getTermArchive, slugOf } from "@data";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardBody } from "oks-ui/card";
import { ArchiveView, archiveTitle } from "./archive-view";
import { canonicalFor } from "./site-url";

type Props = { params: Promise<{ slug?: string[] }> };

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
    // An address that is not an entry may be a category or tag archive ("category/travel").
    const archive = await getTermArchive(slug);
    if (!archive) notFound();
    return <ArchiveView archive={archive} />;
  }
  return (
    <main>
      <h1>{entry.title}</h1>
      <Card>
        <CardBody>
          <article dangerouslySetInnerHTML={{ __html: entry.html }} />
        </CardBody>
      </Card>
    </main>
  );
}
