// The tab strip above the main area (spec 07, section 3a; D111): Dashboard first and never closable, one tab per open
// entry, a dot for unsaved changes, a "+" menu and an "All tabs" menu. A proper tab list for keyboard and screen readers.
import { Button } from "oks-ui";
import { Modal } from "./modal.js";
import { useId, useState, type KeyboardEvent } from "react";

export interface ShellTab {
  key: string;
  title: string;
  href: string;
  /** Unsaved changes: the tab shows a dot, and closing it asks first. */
  dirty?: boolean;
}

export interface TabStripProps {
  /** The first tab is Dashboard: it cannot be closed. */
  tabs: ShellTab[];
  activeKey: string;
  onSelect: (tab: ShellTab) => void;
  onClose: (tab: ShellTab) => void;
  /** The short "Add new" menu behind the "+" button. */
  addItems?: { key: string; label: string; href: string }[];
  onAdd?: (item: { key: string; label: string; href: string }) => void;
  /** More tabs than this and the "All tabs" menu is drawn. */
  overflowAfter?: number;
}

export function TabStrip({
  tabs,
  activeKey,
  onSelect,
  onClose,
  addItems = [],
  onAdd,
  overflowAfter = 5,
}: TabStripProps) {
  const id = useId();
  const [asking, setAsking] = useState<ShellTab | null>(null);
  const [menu, setMenu] = useState<"add" | "all" | null>(null);
  const activeIndex = tabs.findIndex((tab) => tab.key === activeKey);
  const close = (tab: ShellTab) => (tab.dirty ? setAsking(tab) : onClose(tab));
  const moveFocus = (from: number, step: number) => {
    const next = (from + step + tabs.length) % tabs.length;
    document.getElementById(`${id}-tab-${tabs[next]!.key}`)?.focus();
  };
  const keys = (e: KeyboardEvent, index: number, tab: ShellTab) => {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    if (e.key === "ArrowRight") moveFocus(index, rtl ? -1 : 1);
    else if (e.key === "ArrowLeft") moveFocus(index, rtl ? 1 : -1);
    else if (e.key === "Home") moveFocus(0, 0);
    else if (e.key === "End") moveFocus(tabs.length - 1, 0);
    else if (e.key === "Delete" && index > 0) close(tab);
    else return;
    e.preventDefault();
  };
  return (
    <div className="oks-tabs">
      <div role="tablist" aria-label="Open pages" className="oks-tablist">
        {tabs.map((tab, i) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            className="oks-tab"
            data-active={tab.key === activeKey}
            id={`${id}-tab-${tab.key}`}
            aria-selected={tab.key === activeKey}
            tabIndex={tab.key === activeKey ? 0 : -1}
            onClick={() => onSelect(tab)}
            onKeyDown={(e) => keys(e, i, tab)}
          >
            {tab.title}
            {tab.dirty ? (
              <>
                <span className="oks-tab-dot" aria-hidden="true" />
                <span className="oks-visually-hidden"> (unsaved changes)</span>
              </>
            ) : null}
          </button>
        ))}
      </div>
      <div className="oks-tab-tools">
        {/* A tab list may only hold tabs, so the close button is for the open tab (Delete closes any focused tab). */}
        {activeIndex > 0 ? (
          <button
            type="button"
            className="oks-tab-close"
            aria-label={`Close ${tabs[activeIndex]!.title}`}
            onClick={() => close(tabs[activeIndex]!)}
          >
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
        {addItems.length > 0 ? (
          <div className="oks-popup-wrap">
            <button
              type="button"
              aria-label="Add new"
              aria-expanded={menu === "add"}
              aria-controls={`${id}-add`}
              onClick={() => setMenu(menu === "add" ? null : "add")}
            >
              <span aria-hidden="true">+</span>
            </button>
            <ul id={`${id}-add`} className="oks-popup" hidden={menu !== "add"}>
              {addItems.map((item) => (
                <li key={item.key}>
                  <a
                    href={item.href}
                    onClick={() => {
                      setMenu(null);
                      onAdd?.(item);
                    }}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {tabs.length > overflowAfter ? (
          <div className="oks-popup-wrap">
            <button
              type="button"
              aria-expanded={menu === "all"}
              aria-controls={`${id}-all`}
              onClick={() => setMenu(menu === "all" ? null : "all")}
            >
              All tabs
            </button>
            <ul id={`${id}-all`} className="oks-popup" hidden={menu !== "all"}>
              {tabs.map((tab) => (
                <li key={tab.key}>
                  <a
                    href={tab.href}
                    onClick={(e) => {
                      e.preventDefault();
                      setMenu(null);
                      onSelect(tab);
                    }}
                  >
                    {tab.title}
                    {tab.dirty ? " (unsaved changes)" : ""}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <Modal isOpen={asking !== null} onClose={() => setAsking(null)} title="Close without saving?">
        <p>{asking ? `“${asking.title}” has changes that are not saved.` : ""}</p>
        <Button onPress={() => setAsking(null)}>Keep editing</Button>
        <Button
          color="danger"
          onPress={() => {
            if (asking) onClose(asking);
            setAsking(null);
          }}
        >
          Close tab
        </Button>
      </Modal>
    </div>
  );
}

export interface FooterInfo {
  /** The product name comes from the brand file (D84). */
  product: string;
  version: string;
  helpHref?: string;
  docsHref?: string;
  /** A line of the owner's own instead of "Developed with …" (white-label, spec 11, section 5). */
  text?: string;
}

/** The slim line at the bottom (D112). The owner can hide it: the caller then passes nothing. */
export function ShellFooter({ info }: { info: FooterInfo }) {
  return (
    <footer className="oks-footer">
      <span>
        {info.text ?? (
          <>
            Developed with {info.product} · Version {info.version}
          </>
        )}
      </span>
      {info.helpHref ? <a href={info.helpHref}>Help</a> : null}
      {info.docsHref ? <a href={info.docsHref}>Docs</a> : null}
    </footer>
  );
}
