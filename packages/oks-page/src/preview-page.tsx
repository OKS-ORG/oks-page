// /preview/[id]: the saved version of an entry on the real site, for someone with a preview link or a signed-in member
// who may edit it. Never cached and never indexed. Anyone else gets a plain "not found".
import { getSiteMenu } from "@data";
import { enhanceImages, loadPreviewEntry } from "@oks-page/core";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Card, CardBody } from "oks-ui/card";
import { getRunner, getSiteId } from "./db";
import { mayPreview } from "./preview-gate";
import { PublicFrame } from "./public-frame";
import { mediaContext } from "./uploads";

export const metadata: Metadata = {
  title: "Preview",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> };

export default async function PreviewPage({ params, searchParams }: Props) {
  await connection();
  const { id } = await params;
  const { t } = await searchParams;
  if (!(await mayPreview(await headers(), id, typeof t === "string" ? t : null))) notFound();
  const siteId = await getSiteId();
  const entry = await loadPreviewEntry(getRunner(), siteId, id);
  if (!entry) notFound();
  const html = await enhanceImages(getRunner(), siteId, entry.html, mediaContext().storage);
  const [header, footer] = await Promise.all([getSiteMenu("primary"), getSiteMenu("footer")]);
  const notice =
    entry.status === "published"
      ? "Preview: this is the saved version of a published page."
      : "Preview: this page is not published. The public cannot see it.";
  return (
    <PublicFrame header={header} footer={footer}>
      <aside
        aria-label="Preview notice"
        style={{ border: "2px solid currentColor", padding: "0.5rem 1rem", margin: "1rem 0" }}
      >
        <p>{notice}</p>
      </aside>
      <main>
        <h1>{entry.title}</h1>
        <Card>
          <CardBody>
            <article dangerouslySetInnerHTML={{ __html: html }} />
          </CardBody>
        </Card>
      </main>
    </PublicFrame>
  );
}
