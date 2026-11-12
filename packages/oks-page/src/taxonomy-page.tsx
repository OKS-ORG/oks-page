// Categories or Tags, for a signed-in member who may edit all content.
import { ensureDefaultTaxonomies, isSetupDone, loadTaxonomy } from "@oks-page/core";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { TaxonomyScreen } from "./taxonomy-screen";

export async function TaxonomyPage({ taxonomyKey }: { taxonomyKey: "category" | "tag" }) {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("content.edit_any")) redirect("/admin");
  await ensureDefaultTaxonomies(getRunner(), member.siteId);
  const taxonomy = await loadTaxonomy(getRunner(), member.siteId, taxonomyKey);
  if (!taxonomy) notFound();
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="taxonomies"
      title={taxonomy.label}
      breadcrumbs={[{ label: "Posts" }, { label: taxonomy.label }]}
    >
      <TaxonomyScreen taxonomy={taxonomy} />
    </AdminFrame>
  );
}
