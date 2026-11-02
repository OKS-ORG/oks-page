// The admin shell (spec 07, section 3): sidebar on wide screens, drawer below 1025 px, header with breadcrumbs and search,
// a "Skip to content" link, and one main area with the screen's single h1.
import {
  Breadcrumbs,
  BreadcrumbItem,
  Button,
  CommandPalette,
  Drawer,
  Nav,
  useCommandPalette,
  useMediaQuery,
  type CommandPaletteItem,
} from "oks-ui";
import { useRef, useState, type ReactNode } from "react";

export interface ShellNavItem {
  key: string;
  label: string;
  href: string;
}

export interface ShellProps {
  /** The main menu. A count such as "2 new" belongs in the label: oks-ui's `badge` fails axe (work list). */
  nav: ShellNavItem[];
  selectedKey: string;
  /** The screen's title: the one h1 of the page. */
  title: string;
  breadcrumbs?: { label: string; href?: string }[];
  /** What Ctrl+K (or ⌘K) can jump to. */
  searchItems?: CommandPaletteItem[];
  onNavigate?: (href: string) => void;
  children: ReactNode;
}

/** Below this width the sidebar is a drawer (AD-02). */
export const SIDEBAR_QUERY = "(min-width: 1025px)";

export function Shell({
  nav,
  selectedKey,
  title,
  breadcrumbs = [],
  searchItems = [],
  onNavigate,
  children,
}: ShellProps) {
  const wide = useMediaQuery(SIDEBAR_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const palette = useCommandPalette({ hotkey: "mod+k" });
  const menu = (
    <Nav
      aria-label="Main menu"
      items={nav.map(({ key, label, href }) => ({ key, label, href }))}
      selectedKey={selectedKey}
    />
  );
  return (
    <div className="oks-shell">
      <a className="oks-skip" href="#main">
        Skip to content
      </a>
      {wide ? <aside className="oks-sidebar">{menu}</aside> : null}
      <div className="oks-shell-body">
        <header className="oks-header">
          {wide ? null : (
            <Button ref={menuButton} onPress={() => setDrawerOpen(true)}>
              Menu
            </Button>
          )}
          <Breadcrumbs>
            {breadcrumbs.map((b) => (
              <BreadcrumbItem key={b.label} {...(b.href ? { href: b.href } : {})}>
                {b.label}
              </BreadcrumbItem>
            ))}
          </Breadcrumbs>
          <Button onPress={palette.open}>Search</Button>
        </header>
        <main id="main" tabIndex={-1}>
          <h1>{title}</h1>
          {children}
        </main>
      </div>
      {wide ? null : (
        <Drawer
          isOpen={drawerOpen}
          onClose={() => {
            setDrawerOpen(false);
            menuButton.current?.focus();
          }}
          title="Menu"
        >
          {menu}
        </Drawer>
      )}
      <CommandPalette
        {...palette.getPaletteProps()}
        items={searchItems}
        placeholder="Search the admin"
        onSelect={(item) => {
          palette.close();
          const href = (item as { href?: string }).href;
          if (href) onNavigate?.(href);
        }}
      />
    </div>
  );
}
