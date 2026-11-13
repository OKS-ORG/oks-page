// The small menu between the settings groups (Media, Security, Maintenance, Redirects, Search engines).
const GROUPS = [
  { key: "media", label: "Media", href: "/admin/settings/media" },
  { key: "security", label: "Security", href: "/admin/settings/security" },
  { key: "maintenance", label: "Maintenance", href: "/admin/settings/maintenance" },
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
