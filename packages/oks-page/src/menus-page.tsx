// /admin/menus: the header and footer menus, for a signed-in member who may manage menus.
import { isSetupDone, loadMenu, loadMenuChoices, MENU_PLACES } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { actorOf } from "./admin-actor";
import { AdminFrame } from "./admin-frame";
import { navFor } from "./admin-nav";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { MenusScreen } from "./menus-screen";

export const metadata: Metadata = { title: "Menus", robots: { index: false } };

export default async function MenusPage({
  searchParams,
}: {
  searchParams: Promise<{ place?: string }>;
}) {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const member = await signedInMember();
  if (!member) redirect("/admin/login");
  const actor = await actorOf(member);
  if (!actor.can("menus.manage")) redirect("/admin");
  const asked = (await searchParams).place;
  const place = MENU_PLACES.find((p) => p.key === asked)?.key ?? MENU_PLACES[0].key;
  const runner = getRunner();
  const menu = await loadMenu(runner, member.siteId, place);
  const choices = await loadMenuChoices(runner, member.siteId);
  return (
    <AdminFrame
      nav={navFor((c) => actor.can(c))}
      user={member.user}
      product={process.env["OKS_PRODUCT"] ?? ""}
      version={process.env["OKS_VERSION"] ?? ""}
      selectedKey="menus"
      title="Menus"
      breadcrumbs={[{ label: "Menus" }, { label: menu.label }]}
    >
      <MenusScreen
        key={place}
        places={MENU_PLACES.map((p) => ({ key: p.key, label: p.label }))}
        menu={menu}
        choices={choices}
      />
    </AdminFrame>
  );
}
