// The side menu (spec 07, sections 3 and 3a; D110, D143; docs/18-new-look.md): two levels, an expanded state with text and an
// icon rail, named groups such as Content and Site, a "Jump to" search, the update note and the account at the bottom. A thin
// layer of our own, because oks-ui's Nav has no rail or sub-items.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
  /** A count beside the name ("3"). In the rail it becomes a small dot; the count stays in the item's name. */
  badge?: string;
}

export interface SidebarAccount {
  name: string;
  /** A second line: the role or the email. */
  detail?: string;
  href: string;
}

export interface SidebarNotice {
  text: string;
  href: string;
}

export interface SidebarProps {
  nav: ShellNavItem[];
  selectedKey: string;
  /** The icon rail instead of the menu with text. */
  collapsed: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate?: (href: string) => void;
  /** Opens the search ("Jump to", Ctrl K). Leave it out for a menu without search. */
  onJump?: () => void;
  /** Who is signed in, at the bottom of the menu. */
  account?: SidebarAccount;
  /** A short note above the account, such as "Update available". */
  notice?: SidebarNotice;
}

function Icon({ item }: { item: ShellNavItem }) {
  return (
    <span className="oks-menu-icon" aria-hidden="true">
      {item.icon ?? item.label.slice(0, 1)}
    </span>
  );
}

/** What a rail item is called: its text, with the count when it has one. */
const nameOf = (item: ShellNavItem): string =>
  item.badge ? `${item.label} (${item.badge})` : item.label;

function Badge({ item }: { item: ShellNavItem }) {
  return item.badge ? (
    <span className="oks-menu-badge" aria-hidden="true">
      {item.badge}
    </span>
  ) : null;
}

/** In the rail a count becomes a small dot; the count is still in the item's name. */
function Dot({ item }: { item: ShellNavItem }) {
  return item.badge ? <span className="oks-menu-dot" aria-hidden="true" /> : null;
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
        {...(collapsed
          ? { "aria-label": nameOf(item), "data-tip": item.label }
          : item.badge
            ? { "aria-label": nameOf(item) }
            : {})}
        onClick={() => setOpen(!open)}
      >
        <Icon item={item} />
        {collapsed ? (
          <Dot item={item} />
        ) : (
          <>
            <span className="oks-menu-text">{item.label}</span>
            <Badge item={item} />
            <span className="oks-menu-caret" aria-hidden="true" />
          </>
        )}
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
        {...(collapsed
          ? { "aria-label": nameOf(item), "data-tip": item.label }
          : item.badge
            ? { "aria-label": nameOf(item) }
            : {})}
      >
        <Icon item={item} />
        {collapsed ? (
          <Dot item={item} />
        ) : (
          <>
            <span className="oks-menu-text">{item.label}</span>
            <Badge item={item} />
          </>
        )}
      </a>
    </li>
  );
}

const CHEVRON = (
  <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" className="oks-toggle-icon">
    <path d="M15 6l-6 6 6 6" />
  </svg>
);

/** The sidebar of a wide screen: the logo and the button that switches between the menu and the rail, the search, the menu, the account. */
export function Sidebar({
  nav,
  selectedKey,
  collapsed,
  onCollapsedChange,
  onJump,
  account,
  notice,
}: SidebarProps) {
  // The name of an icon in the rail: a small dark tip beside it, on hover and on keyboard focus. It is drawn outside the
  // scrolling menu (position: fixed), so it is never clipped.
  const [tip, setTip] = useState<{
    text: string;
    top: number;
    start: number;
    host: Element;
  } | null>(null);
  const show = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;
    if (!collapsed || !el || el.getAttribute("aria-expanded") === "true") return setTip(null);
    const rect = el.getBoundingClientRect();
    const rtl = getComputedStyle(el).direction === "rtl";
    setTip({
      text: el.getAttribute("data-tip") ?? "",
      top: rect.top + rect.height / 2,
      start: rtl ? window.innerWidth - rect.left + 12 : rect.right + 12,
      // Inside the admin's own wrapper, so the colours (CSS variables) reach it; the sidebar itself has a blur, which would
      // make a fixed child position itself against the sidebar.
      host: el.closest(".oks-admin") ?? document.body,
    });
  };
  return (
    <aside
      className="oks-sidebar"
      data-collapsed={collapsed}
      onPointerOver={(e) => show(e.target)}
      onFocus={(e) => show(e.target)}
      onPointerLeave={() => setTip(null)}
      onBlur={() => setTip(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setTip(null);
      }}
    >
      <div className="oks-sidebar-top">
        <button
          type="button"
          className="oks-menu-toggle"
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          aria-keyshortcuts="["
          data-tip={collapsed ? "Expand menu" : "Collapse menu"}
          onClick={() => onCollapsedChange?.(!collapsed)}
        >
          {CHEVRON}
        </button>
      </div>
      {onJump ? (
        <button
          type="button"
          className="oks-jump"
          aria-keyshortcuts="Control+K"
          {...(collapsed ? { "aria-label": "Jump to", "data-tip": "Jump to (Ctrl K)" } : {})}
          onClick={onJump}
        >
          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" className="oks-jump-icon">
            <circle cx="11" cy="11" r="6" />
            <path d="M16 16l4 4" />
          </svg>
          {collapsed ? null : (
            <>
              <span className="oks-jump-text">Jump to...</span>
              <kbd>Ctrl K</kbd>
            </>
          )}
        </button>
      ) : null}
      <SidebarMenu nav={nav} selectedKey={selectedKey} collapsed={collapsed} />
      {notice || account ? (
        <div className="oks-sidebar-foot">
          {notice && !collapsed ? (
            <a className="oks-notice" href={notice.href}>
              {notice.text}
            </a>
          ) : null}
          {account ? (
            <a
              className="oks-account"
              href={account.href}
              {...(collapsed ? { "aria-label": account.name, "data-tip": account.name } : {})}
            >
              <span className="oks-avatar" aria-hidden="true">
                {account.name.trim().slice(0, 1).toUpperCase() || "?"}
              </span>
              {collapsed ? null : (
                <span className="oks-account-text">
                  <b>{account.name}</b>
                  {account.detail ? <span>{account.detail}</span> : null}
                </span>
              )}
            </a>
          ) : null}
        </div>
      ) : null}
      {tip
        ? createPortal(
            <div
              className="oks-tip"
              role="tooltip"
              style={{ position: "fixed", top: tip.top, insetInlineStart: tip.start }}
            >
              {tip.text}
            </div>,
            tip.host,
          )
        : null}
    </aside>
  );
}
