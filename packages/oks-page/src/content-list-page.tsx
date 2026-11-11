// The server side of the list screens: only a signed-in member who may edit this kind of content sees them.
import { isSetupDone, listEntries } from "@oks-page/core";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { signedInMember } from "./admin-session";
import { ContentList } from "./content-list";
import { getRunner } from "./db";

export interface ContentKind {
  type: string;
  segment: string;
  singular: string;
  title: string;
}

export async function ContentListPage({ kind }: { kind: ContentKind }) {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  const entries = await listEntries(getRunner(), actor, member.siteId, kind.type);
  return (
    <AdminFrame
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey={kind.segment}
      title={kind.title}
      breadcrumbs={[{ label: kind.title }]}
    >
      <ContentList
        type={kind.type}
        segment={kind.segment}
        singular={kind.singular}
        entries={entries}
        canAdd={actor.can("content.create", kind.type)}
      />
    </AdminFrame>
  );
}
