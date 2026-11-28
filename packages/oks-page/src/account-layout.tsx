// "Your account" as the boards lay it out: a small menu on the left for the parts of your own account, and the chosen part's
// cards on the right.
import type { ReactNode } from "react";

const PARTS = [
  { key: "account", label: "Sign-in", href: "/admin/account" },
  { key: "appearance", label: "Appearance", href: "/admin/account/appearance" },
];

export function AccountLayout({
  current,
  line,
  children,
}: {
  current: "account" | "appearance";
  /** The sentence under the title: what this part of the account is for. */
  line: string;
  children: ReactNode;
}) {
  return (
    <div className="oks-me">
      <nav aria-label="Your account" className="oks-me-menu">
        <ul>
          {PARTS.map((part) => (
            <li key={part.key}>
              <a href={part.href} {...(part.key === current ? { "aria-current": "page" } : {})}>
                {part.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="oks-me-main">
        <p className="oks-list-summary">{line}</p>
        {children}
      </div>
    </div>
  );
}
