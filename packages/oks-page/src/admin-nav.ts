// The admin menu. Each person sees only the places they may use; the screens check the rule again on the server.
export interface NavItem {
  key: string;
  label: string;
  href: string;
}

const ANY = (can: (capability: string) => boolean, capabilities: string[]) =>
  capabilities.some((c) => can(c));

const ITEMS: (NavItem & { needs: string[] })[] = [
  { key: "home", label: "Home", href: "/admin", needs: [] },
  {
    key: "pages",
    label: "Pages",
    href: "/admin/pages",
    needs: ["content.create", "content.edit_own", "content.edit_any"],
  },
  {
    key: "posts",
    label: "Posts",
    href: "/admin/posts",
    needs: ["content.create", "content.edit_own", "content.edit_any"],
  },
  {
    key: "content",
    label: "Content",
    href: "/admin/content",
    needs: ["content_types.manage", "content.edit_any"],
  },
  { key: "comments", label: "Comments", href: "/admin/comments", needs: ["comments.moderate"] },
  {
    key: "taxonomies",
    label: "Categories and tags",
    href: "/admin/categories",
    needs: ["content.edit_any"],
  },
  { key: "menus", label: "Menus", href: "/admin/menus", needs: ["menus.manage"] },
  {
    key: "media",
    label: "Media",
    href: "/admin/media",
    needs: ["media.upload", "media.edit_own", "media.edit_any"],
  },
  { key: "users", label: "Users", href: "/admin/users", needs: ["users.manage"] },
  { key: "tools", label: "Tools", href: "/admin/tools/search", needs: ["settings.manage"] },
  {
    key: "settings",
    label: "Settings",
    href: "/admin/settings/general",
    needs: ["settings.manage"],
  },
];

/** The menu items a person with these capabilities sees. Home is for everyone who is signed in. */
export function navFor(can: (capability: string) => boolean): NavItem[] {
  return ITEMS.filter((i) => i.needs.length === 0 || ANY(can, i.needs)).map(
    ({ key, label, href }) => ({ key, label, href }),
  );
}
