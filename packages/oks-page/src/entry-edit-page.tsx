// /admin/pages/[id] and /admin/posts/[id]: the edit screen. Anyone who may not edit this entry is sent back to the list.
import { pluginBlockTypes } from "./plugin-blocks";
import {
  insertableSections,
  isSetupDone,
  listContentTypes,
  loadForEdit,
  loadGeneralSettings,
  loadScreenSizes,
} from "@oks-page/core";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { EntryEditScreen, type EntryEditScreenProps } from "./entry-edit-screen";

export const metadata: Metadata = { title: "Edit", robots: { index: false } };

export default async function EntryEditPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  const { id } = await params;
  const loaded = await loadForEdit(getRunner(), actor, member.siteId, id);
  if (!loaded.ok) {
    if (loaded.code === "not_found") notFound();
    redirect("/admin");
  }
  const { entry } = loaded;
  const { timeZone } = await loadGeneralSettings(getRunner(), member.siteId);
  const savedSections = await insertableSections(getRunner(), member.siteId);
  const screens = await loadScreenSizes(getRunner(), member.siteId);
  const pluginBlocks = (await pluginBlockTypes(getRunner(), member.siteId)).map(
    ({ type, label, fields, presets }) => ({ type, label, fields, presets }),
  );
  const typeInfo = (await listContentTypes(getRunner(), member.siteId)).find(
    (t) => t.key === entry.type,
  );
  const custom = entry.type !== "post" && entry.type !== "page";
  const segment = entry.type === "post" ? "posts" : custom ? `content/${entry.type}` : "pages";
  const listLabel =
    entry.type === "post" ? "Posts" : custom ? (typeInfo?.label ?? entry.type) : "Pages";
  const canPublish =
    actor.can("content.publish_any", entry.type) ||
    (actor.can("content.publish_own", entry.type) && entry.authorId === actor.userId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey={custom ? "content" : segment}
      title={`Edit: ${entry.title}`}
      breadcrumbs={[{ label: listLabel, href: `/admin/${segment}` }, { label: entry.title }]}
    >
      <EntryEditScreen
        id={entry.id}
        title={entry.title}
        slugPart={entry.slugPart}
        prefix={entry.prefix}
        status={entry.status}
        scheduledAt={entry.scheduledAt}
        revision={entry.revision}
        // The stored blocks passed the block checks; oks-ui's own type is stricter than the checks' type.
        blocks={entry.blocks as unknown as EntryEditScreenProps["blocks"]}
        savedSections={savedSections}
        canPublish={canPublish}
        canTrash={
          actor.can("content.delete_any", entry.type) ||
          (actor.can("content.delete_own", entry.type) && entry.authorId === actor.userId)
        }
        showTerms={entry.type === "post"}
        editor={entry.editor}
        canLock={actor.can("themes.manage")}
        screens={screens}
        pluginBlocks={pluginBlocks}
        timeZone={timeZone}
        listHref={`/admin/${segment}`}
        fieldDefs={entry.fieldDefs}
        fieldValues={entry.fieldValues}
      />
    </AdminFrame>
  );
}
