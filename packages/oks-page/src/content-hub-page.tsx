// /admin/content: the custom content types of the site, each with a link to its list. Page and Post have their own menu items.
import { isSetupDone, listContentTypes } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";

export const metadata: Metadata = { title: "Content", robots: { index: false } };

export default async function ContentHubPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  const types = (await listContentTypes(getRunner(), member.siteId)).filter((t) => !t.builtIn);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="content"
      title="Content"
      breadcrumbs={[{ label: "Content" }]}
    >
      <h2>Content</h2>
      {types.length === 0 ? (
        <p>
          There are no content types of your own yet.
          {actor.can("content_types.manage") ? (
            <>
              {" "}
              <a href="/admin/settings/content-types">Make one in Settings</a>.
            </>
          ) : null}
        </p>
      ) : (
        <ul>
          {types
            .filter(
              (t) =>
                actor.can("content.create", t.key) ||
                actor.can("content.edit_any", t.key) ||
                actor.can("content.edit_own", t.key),
            )
            .map((t) => (
              <li key={t.key}>
                <a href={`/admin/content/${t.key}`}>{t.label}</a> ({t.entryCount})
              </li>
            ))}
        </ul>
      )}
    </AdminFrame>
  );
}
