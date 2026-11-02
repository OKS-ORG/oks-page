// The admin shell (spec 07, section 3): sidebar on wide screens, drawer below 1025 px, header with breadcrumbs and search,
// a "Skip to content" link, and one main area with the screen's single h1.
import { Sidebar, SidebarMenu, type ShellNavItem } from "./sidebar.js";
import { ShellFooter, TabStrip, type FooterInfo, type TabStripProps } from "./tabs.js";
import {
  Breadcrumbs,
  BreadcrumbItem,
  Button,
  CommandPalette,
  Drawer,
  useCommandPalette,
  useMediaQuery,
  type CommandPaletteItem,
} from "oks-ui";
import { useRef, useState, type ReactNode } from "react";

export interface ShellProps {
  /** The main menu. A count such as "2 new" belongs in the label: oks-ui's `badge` fails axe (work list). */
  nav: ShellNavItem[];
  /** The sidebar starts as the icon rail. The caller remembers the choice for each user (D110). */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  selectedKey: string;
  /** The screen's title: the one h1 of the page. */
  title: string;
  breadcrumbs?: { label: string; href?: string }[];
  /** What Ctrl+K (or ⌘K) can jump to. */
  searchItems?: CommandPaletteItem[];
  onNavigate?: (href: string) => void;
  /** The reading direction of the admin's language. The drawer opens on the start side (oks-ui's own `start` is not built yet). */
  dir?: "ltr" | "rtl";
  /** The tab strip above the main area. Leave it out for a screen without tabs. */
  tabs?: TabStripProps;
  /** The slim footer. The owner can hide it (D112): then pass nothing. */
  footer?: FooterInfo;
  children: ReactNode;
}

/** Below this width the sidebar is a drawer (AD-02). */
export const SIDEBAR_QUERY = "(min-width: 1025px)";

export function Shell({
  nav,
  collapsed: collapsedProp = false,
  onCollapsedChange,
  selectedKey,
  title,
  breadcrumbs = [],
  searchItems = [],
  onNavigate,
  dir = "ltr",
  tabs,
  footer,
  children,
}: ShellProps) {
  const wide = useMediaQuery(SIDEBAR_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const palette = useCommandPalette({ hotkey: "mod+k" });
  const [collapsed, setCollapsed] = useState(collapsedProp);
  const menu = <SidebarMenu nav={nav} selectedKey={selectedKey} collapsed={false} />;
  return (
    <div className="oks-shell" dir={dir}>
      <a className="oks-skip" href="#main">
        Skip to content
      </a>
      {wide ? (
        <Sidebar
          nav={nav}
          selectedKey={selectedKey}
          collapsed={collapsed}
          onCollapsedChange={(next) => {
            setCollapsed(next);
            onCollapsedChange?.(next);
          }}
        />
      ) : null}
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
        {tabs ? <TabStrip {...tabs} /> : null}
        <main id="main" tabIndex={-1}>
          <h1>{title}</h1>
          {children}
        </main>
        {footer ? <ShellFooter info={footer} /> : null}
      </div>
      {wide ? null : (
        <Drawer
          isOpen={drawerOpen}
          onClose={() => {
            setDrawerOpen(false);
            menuButton.current?.focus();
          }}
          title="Menu"
          position={dir === "rtl" ? "right" : "left"}
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
