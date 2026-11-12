// The small menu between the settings groups (Media, Security).
const GROUPS = [
  { key: "media", label: "Media", href: "/admin/settings/media" },
  { key: "security", label: "Security", href: "/admin/settings/security" },
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
