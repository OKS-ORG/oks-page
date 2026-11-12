// What every public page has around its content: the header menu above it and the footer menu below it. A menu with
// nothing in it draws nothing. Used by the server build and the export build, so both write the same page.
import type { PublicMenuItem } from "@oks-page/core";
import type { ReactNode } from "react";

// A link is at least 24 px high so it is easy to hit with a finger or a mouse (WCAG 2.2, target size).
const LINK: React.CSSProperties = {
  display: "inline-block",
  minBlockSize: "24px",
  paddingBlock: "2px",
};

function MenuList({ items }: { items: PublicMenuItem[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          <a href={item.href} style={LINK}>
            {item.label}
          </a>
          {item.children.length > 0 ? <MenuList items={item.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function PublicFrame({
  header,
  footer,
  children,
}: {
  header: PublicMenuItem[];
  footer: PublicMenuItem[];
  children: ReactNode;
}) {
  return (
    <>
      {header.length > 0 ? (
        <header>
          <nav aria-label="Main menu">
            <MenuList items={header} />
          </nav>
        </header>
      ) : null}
      {children}
      {footer.length > 0 ? (
        <footer>
          <nav aria-label="Footer menu">
            <MenuList items={footer} />
          </nav>
        </footer>
      ) : null}
    </>
  );
}
