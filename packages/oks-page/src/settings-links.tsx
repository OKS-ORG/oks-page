// The small menu between the settings groups (General, Media, Security, Maintenance, Redirects, Search engines).
const GROUPS = [
  { key: "general", label: "General", href: "/admin/settings/general" },
  { key: "reading", label: "Reading", href: "/admin/settings/reading" },
  { key: "writing", label: "Writing", href: "/admin/settings/writing" },
  { key: "languages", label: "Languages", href: "/admin/settings/languages" },
  { key: "email", label: "Email", href: "/admin/settings/email" },
  { key: "look", label: "Look", href: "/admin/settings/look" },
  { key: "themes", label: "Themes", href: "/admin/settings/themes" },
  { key: "site-editor", label: "Site editor", href: "/admin/settings/site-editor" },
  { key: "media", label: "Media", href: "/admin/settings/media" },
  { key: "security", label: "Security", href: "/admin/settings/security" },
  { key: "advanced", label: "Advanced", href: "/admin/settings/advanced" },
  { key: "redirects", label: "Redirects", href: "/admin/settings/redirects" },
  { key: "seo", label: "Search engines", href: "/admin/settings/search-engines" },
];

export function SettingsLinks({ current }: { current: string }) {
  return (
    <nav aria-label="Settings groups">
      <ul style={{ display: "flex", gap: "1rem", listStyle: "none", padding: 0 }}>
        {GROUPS.map((g) => (
          <li key={g.key}>
            <a href={g.href} {...(g.key === current ? { "aria-current": "page" as const } : {})}>
              {g.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
