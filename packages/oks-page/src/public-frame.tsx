// What every public page has around its content: the header menu above it and the footer menu below it. A menu with
// nothing in it draws nothing. Used by the server build and the export build, so both write the same page.
import { getLook, getSiteInfo } from "@data";
import type { PublicMenuItem } from "@oks-page/core";
import { COLOR_MODE_SCRIPT, needsColorMode } from "@oks-page/core/theme";
import { BlockBehaviour } from "./block-behaviour";
import { ColorModeSwitch } from "./color-mode-switch";
import type { Look } from "./data/types";
import type { ReactNode } from "react";

// A link is at least 24 px high so it is easy to hit with a finger or a mouse (WCAG 2.2, target size).
export const LINK: React.CSSProperties = {
  display: "inline-block",
  minBlockSize: "24px",
  paddingBlock: "2px",
};

export function MenuList({ items }: { items: PublicMenuItem[] }) {
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

/**
 * The theme's CSS file first (checked when the theme was installed, served from the site with its fingerprint in the
 * name), then the owner's colors and fonts, written by the core from checked values only, so they win.
 */
export function LookStyles({ look }: { look: Look }) {
  return (
    <>
      {look.themeCssUrl ? <link rel="stylesheet" href={look.themeCssUrl} /> : null}
      {look.cssUrl ? (
        <link rel="stylesheet" href={look.cssUrl} />
      ) : look.css ? (
        <style dangerouslySetInnerHTML={{ __html: look.css }} />
      ) : null}
      {needsColorMode(look.colorMode, look.modeSwitch) ? (
        <script
          data-mode={look.colorMode}
          data-switch={look.modeSwitch ? "1" : "0"}
          dangerouslySetInnerHTML={{ __html: COLOR_MODE_SCRIPT }}
        />
      ) : null}
      {look.modeSwitch ? <ColorModeSwitch /> : null}
    </>
  );
}

export async function PublicFrame({
  header,
  footer,
  children,
  look: given,
}: {
  header: PublicMenuItem[];
  footer: PublicMenuItem[];
  children: ReactNode;
  /** A look chosen by the caller (the preview of a theme); the site's own look when left out. */
  look?: Look;
}) {
  const [look, site] = await Promise.all([given ?? getLook(), getSiteInfo()]);
  const { logo } = look;
  // The site's language and writing direction (Settings > Languages) on everything the visitor reads.
  return (
    <div lang={site.lang} dir={site.dir} className="oks-site">
      <LookStyles look={look} />
      <BlockBehaviour />
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
    </div>
  );
}
