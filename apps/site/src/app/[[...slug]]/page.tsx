import { getPublishedEntry, slugOf } from "@data";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { canonicalFor } from "../../site-url";

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = slugOf((await params).slug);
  const entry = await getPublishedEntry(slug);
  return entry ? { title: entry.title, alternates: { canonical: canonicalFor(slug) } } : {};
}

export default async function Page({ params }: Props) {
  const entry = await getPublishedEntry(slugOf((await params).slug));
  if (!entry) notFound();
  return (
    <main>
      <h1>{entry.title}</h1>
      <article dangerouslySetInnerHTML={{ __html: entry.html }} />
    </main>
  );
}
