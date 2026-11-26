"use client";
// The admin shell around a screen: the menu, the footer, who is signed in and Sign out.
import { Shell } from "@oks-page/admin";
import "@oks-page/admin/shell.css";
import "@oks-page/admin/base.css";
import { Button, type CommandPaletteItem } from "oks-ui";
import { useCallback, useMemo, type ReactNode } from "react";
import { useAdminBrand } from "./admin-brand-context";
import type { NavItem } from "./admin-nav";
import { navIcon } from "./nav-icons";

async function signOut() {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  window.location.assign("/admin/login");
}

/** What Ctrl+K can jump to without a lookup: every menu item, and the settings screens for those who may open settings. */
export function paletteItems(nav: NavItem[]): CommandPaletteItem[] {
  const items: (CommandPaletteItem & { href: string })[] = nav.map((n) => ({
    id: `go:${n.key}`,
    label: n.label,
    group: "Go to",
    href: n.href,
  }));
  if (nav.some((n) => n.key === "settings"))
    for (const [path, label] of SETTINGS_SCREENS)
      items.push({
        id: `settings:${path}`,
        label: `Settings: ${label}`,
        group: "Settings",
        keywords: ["settings", label],
        href: `/admin/settings/${path}`,
      });
  return items;
}

const SETTINGS_SCREENS: [string, string][] = [
  ["general", "General"],
  ["look", "Look"],
  ["themes", "Themes"],
  ["site-editor", "Site editor"],
  ["media", "Media"],
  ["reading", "Reading"],
  ["writing", "Writing"],
  ["languages", "Languages"],
  ["search-engines", "Search engines"],
  ["redirects", "Redirects"],
  ["privacy", "Privacy"],
  ["security", "Security"],
  ["email", "Email"],
  ["domains", "Domains"],
  ["maintenance", "Maintenance"],
  ["advanced", "Advanced"],
];

/** Pages and posts whose title holds the words typed (the API leaves out what the person may not edit). */
async function searchEntries(query: string): Promise<CommandPaletteItem[]> {
  const response = await fetch(`/api/admin/entries?q=${encodeURIComponent(query)}`);
  if (!response.ok) return [];
  const body = (await response.json()) as {
    hits: { id: string; type: "page" | "post"; title: string; status: string }[];
  };
  return body.hits.map((h) => ({
    id: `entry:${h.id}`,
    label: h.title || "(no title)",
    description: `${h.type === "page" ? "Page" : "Post"} · ${h.status}`,
    group: "Pages and posts",
    href: `/admin/${h.type === "page" ? "pages" : "posts"}/${h.id}`,
  }));
}

export interface AdminFrameProps {
  user: { name: string; email: string };
  /** The menu for this person (see `navFor`). */
  nav: NavItem[];
  product: string;
  version: string;
  selectedKey: string;
  title: string;
  breadcrumbs?: { label: string; href?: string }[];
  children: ReactNode;
}

export function AdminFrame({
  user,
  nav,
  product,
  version,
  selectedKey,
  title,
  breadcrumbs,
  children,
}: AdminFrameProps) {
  const brand = useAdminBrand();
  const items = useMemo(() => paletteItems(nav), [nav]);
  const canSearch = nav.some((n) => n.key === "pages" || n.key === "posts");
  const onSearch = useCallback(searchEntries, []);
  return (
    <Shell
      nav={nav.map((n) => {
        const icon = navIcon(n.key);
        return icon ? { ...n, icon } : n;
      })}
      selectedKey={selectedKey}
      title={title}
      {...(breadcrumbs ? { breadcrumbs } : {})}
      footer={{
        product: brand.name || product,
        version,
        ...(brand.footerText ? { text: brand.footerText } : {}),
        ...(brand.helpHref ? { helpHref: brand.helpHref } : {}),
      }}
      {...(brand.name || brand.logoUrl
        ? { brand: { name: brand.name, ...(brand.logoUrl ? { logoUrl: brand.logoUrl } : {}) } }
        : {})}
      searchItems={items}
      {...(canSearch ? { onSearch } : {})}
      onNavigate={(href) => window.location.assign(href)}
    >
      <p>
        Signed in as {user.name} ({user.email}) · <a href="/admin/account">Your account</a>{" "}
        <Button onPress={() => void signOut()}>Sign out</Button>
      </p>
      {children}
    </Shell>
  );
}
