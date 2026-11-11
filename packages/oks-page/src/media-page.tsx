// The media library screen, for a signed-in member who may use the library.
import { isSetupDone, listMedia } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { MediaLibraryScreen } from "./media-library";
import { mediaContext } from "./uploads";

export const metadata: Metadata = { title: "Media", robots: { index: false } };

export default async function MediaPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  const list = await listMedia(getRunner(), mediaContext(), actor, member.siteId, { limit: 40 });
  if (!list.ok) redirect("/admin");
  return (
    <AdminFrame
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="media"
      title="Media"
      breadcrumbs={[{ label: "Media" }]}
    >
      <MediaLibraryScreen
        initial={{ items: list.items, total: list.total }}
        canUpload={actor.can("media.upload")}
        canDelete={actor.can("media.delete_any")}
      />
    </AdminFrame>
  );
}
