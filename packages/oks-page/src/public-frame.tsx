// What every public page has around its content: the header menu above it and the footer menu below it. A menu with
// nothing in it draws nothing. Used by the server build and the export build, so both write the same page.
import { getLook } from "@data";
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

export async function PublicFrame({
  header,
  footer,
  children,
}: {
  header: PublicMenuItem[];
  footer: PublicMenuItem[];
  children: ReactNode;
}) {
  // The owner's colors and fonts. The CSS is written by the core from checked values only, so it holds nothing else.
  const { css: themeCss, logo } = await getLook();
  return (
    <>
      {themeCss ? <style dangerouslySetInnerHTML={{ __html: themeCss }} /> : null}
      {header.length > 0 || logo ? (
        <header>
          {logo ? (
            <a href="/" style={LINK}>
              <img
                src={logo.url}
                alt={logo.alt}
                {...(logo.width && logo.height ? { width: logo.width, height: logo.height } : {})}
                style={{ maxBlockSize: "4rem", inlineSize: "auto" }}
              />
            </a>
          ) : null}
          {header.length > 0 ? (
            <nav aria-label="Main menu">
              <MenuList items={header} />
            </nav>
          ) : null}
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
