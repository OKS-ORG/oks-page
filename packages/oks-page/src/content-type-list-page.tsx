// /admin/content/[type]: the list of one custom content type.
import { listContentTypes } from "@oks-page/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ContentListPage } from "./content-list-page";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Content", robots: { index: false } };

export default async function ContentTypeListPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  await connection();
  const { type } = await params;
  const member = await signedInMember();
  const info = member
    ? (await listContentTypes(getRunner(), member.siteId)).find((t) => t.key === type)
    : undefined;
  // Without a session the list page sends the visitor to the login; a type that does not exist is a 404.
  if (member && (!info || info.builtIn)) notFound();
  return (
    <ContentListPage
      searchParams={searchParams}
      kind={{
        type,
        segment: `content/${type}`,
        singular: (info?.label ?? type).toLowerCase(),
        title: info?.label ?? "Content",
      }}
    />
  );
}
