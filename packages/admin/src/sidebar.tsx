// The side menu (spec 07, sections 3 and 3a; D110, D143): two levels, an expanded state with text and an icon rail,
// and named groups such as Tools. A thin layer of our own, because oks-ui's Nav has no rail or sub-items.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface MenuLink {
  key: string;
  label: string;
  href: string;
}

export interface ShellNavItem extends MenuLink {
  /** Drawn in the rail. Its text is still the accessible name. A letter is drawn when there is none. */
  icon?: ReactNode;
  /** Second level. Two levels at most. */
  children?: MenuLink[];
  /** Items with the same group follow each other under one heading (for example "Tools"). No group means the main list. */
  group?: string;
}

export interface SidebarProps {
  nav: ShellNavItem[];
  selectedKey: string;
  /** The icon rail instead of the menu with text. */
  collapsed: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate?: (href: string) => void;
}

function Icon({ item }: { item: ShellNavItem }) {
  return (
    <span className="oks-menu-icon" aria-hidden="true">
      {item.icon ?? item.label.slice(0, 1)}
    </span>
  );
}

/** An item with sub-items: in the menu it opens under the item, in the rail it opens as a small flyout. */
function Branch({
  item,
  selectedKey,
  collapsed,
}: {
  item: ShellNavItem & { children: MenuLink[] };
  selectedKey: string;
  collapsed: boolean;
}) {
  const id = useId();
  const holds = item.children.some((c) => c.key === selectedKey);
  const [open, setOpen] = useState(holds);
  const root = useRef<HTMLLIElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!collapsed || !open) return;
    const away = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [collapsed, open]);
  return (
    <li
      ref={root}
      className="oks-menu-item"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="oks-menu-link"
        aria-expanded={open}
        aria-controls={id}
        {...(collapsed ? { "aria-label": item.label, title: item.label } : {})}
        onClick={() => setOpen(!open)}
      >
        <Icon item={item} />
        {collapsed ? null : <span className="oks-menu-text">{item.label}</span>}
      </button>
      <ul id={id} className={collapsed ? "oks-flyout" : "oks-submenu"} hidden={!open}>
        {collapsed ? <li className="oks-flyout-title">{item.label}</li> : null}
        {item.children.map((c) => (
          <li key={c.key}>
            <a
              href={c.href}
              {...(c.key === selectedKey ? { "aria-current": "page" as const } : {})}
            >
              {c.label}
            </a>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function SidebarMenu({
  nav,
  selectedKey,
  collapsed,
}: Pick<SidebarProps, "nav" | "selectedKey" | "collapsed">) {
  // Items with the same group sit together under one heading; the heading names a nested list.
  const blocks: { group: string | undefined; items: ShellNavItem[] }[] = [];
  for (const item of nav) {
    const last = blocks[blocks.length - 1];
    if (last && last.group === item.group) last.items.push(item);
    else blocks.push({ group: item.group, items: [item] });
  }
  const row = (item: ShellNavItem) => (
    <MenuRow key={item.key} item={item} selectedKey={selectedKey} collapsed={collapsed} />
  );
  return (
    <nav aria-label="Main menu" className="oks-menu" data-collapsed={collapsed}>
      <ul>
        {blocks.map((block, i) =>
          block.group ? (
            <li key={`${block.group}-${i}`} className="oks-menu-group">
              <span className="oks-menu-heading" id={`oks-group-${i}`} hidden={collapsed}>
                {block.group}
              </span>
              <ul aria-labelledby={`oks-group-${i}`}>{block.items.map(row)}</ul>
            </li>
          ) : (
            block.items.map(row)
          ),
        )}
      </ul>
    </nav>
  );
}

function MenuRow({
  item,
  selectedKey,
  collapsed,
}: {
  item: ShellNavItem;
  selectedKey: string;
  collapsed: boolean;
}) {
  if (item.children && item.children.length > 0)
    return (
      <Branch
        item={{ ...item, children: item.children }}
        selectedKey={selectedKey}
        collapsed={collapsed}
      />
    );
  return (
    <li className="oks-menu-item">
      <a
        className="oks-menu-link"
        href={item.href}
        {...(item.key === selectedKey ? { "aria-current": "page" as const } : {})}
        {...(collapsed ? { "aria-label": item.label, title: item.label } : {})}
      >
        <Icon item={item} />
        {collapsed ? null : <span className="oks-menu-text">{item.label}</span>}
      </a>
    </li>
  );
}

/** The sidebar of a wide screen: the menu and the button that switches between the menu and the rail. */
export function Sidebar({ nav, selectedKey, collapsed, onCollapsedChange }: SidebarProps) {
  return (
    <aside className="oks-sidebar" data-collapsed={collapsed}>
      <SidebarMenu nav={nav} selectedKey={selectedKey} collapsed={collapsed} />
      <button
        type="button"
        className="oks-menu-toggle"
        aria-label={collapsed ? "Expand menu" : "Collapse menu"}
        {...(collapsed ? { title: "Expand menu" } : {})}
        onClick={() => onCollapsedChange?.(!collapsed)}
      >
        {collapsed ? <span aria-hidden="true">☰</span> : "Collapse menu"}
      </button>
    </aside>
  );
}
