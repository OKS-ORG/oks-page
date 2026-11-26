// The small icons of the admin menu: plain outlines on a 24 x 24 grid, drawn in the colour of the text, so light, dark and a brand
// colour all work. A menu entry without an icon here shows its first letter, as before.
import type { ReactNode } from "react";

const PATHS: Record<string, string> = {
  home: "M4 4h7v7H4z M13 4h7v4h-7z M13 10h7v10h-7z M4 13h7v7H4z",
  pages: "M7 3h7l5 5v13H7zM14 3v5h5",
  posts: "M5 4h14v16H5z M8 9h8 M8 13h8 M8 17h5",
  content: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  comments: "M4 5h16v11H9l-5 4z",
  taxonomies: "M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
  menus: "M4 6h16M4 12h16M4 18h10",
  media: "M4 5h16v14H4z M4 17l5-5 4 4 3-3 4 4",
  users:
    "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6 M17 11a2.5 2.5 0 1 0 0-5 M17 14c2.5.3 4 2.3 4 5",
  tools: "M4 7h10 M18 7h2 M4 17h2 M10 17h10 M14 5v4 M6 15v4",
  plugins: "M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4H4v-4h2a2 2 0 1 0 0-4H4V6h6z",
  publish: "M12 4v11 M7 11l5 5 5-5 M4 20h16",
  statistics: "M5 20V10M12 20V4M19 20v-7",
  handoff: "M9 6h11M9 12h11M9 18h11M4 6l1.2 1.2L7 5M4 12l1.2 1.2L7 11M4 18l1.2 1.2L7 17",
  collect: "M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5",
  backups: "M4 7h16v4H4zM6 11v9h12v-9M10 15h4",
  updates: "M20 12a8 8 0 1 0-3 6.2M20 5v5h-5",
  health: "M3 12h4l2-6 4 12 2-6h6",
  connector:
    "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  agency: "M4 8h16v11H4zM9 8V5h6v3M4 13h16",
  "privacy-requests": "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z",
  settings:
    "M4 7h10 M18 7h2 M4 17h2 M10 17h10 M14 5v4 M6 15v4",
};

/** The icon of a menu entry, or undefined (the menu then shows the first letter). */
export function navIcon(key: string): ReactNode | undefined {
  const d = PATHS[key];
  if (!d) return undefined;
  return (
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
