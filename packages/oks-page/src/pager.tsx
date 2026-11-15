// "Newer posts · Page 2 of 5 · Older posts" under a list of posts. Shown only when the list has more than one page. Plain
// links, so it works with no script and in the static export. Used by the server build and the export build alike.
import { pagePath } from "./paging";

// Links are at least 24 px tall (WCAG 2.2 target size).
const LINK: React.CSSProperties = {
  display: "inline-block",
  minBlockSize: "24px",
  lineHeight: "24px",
  paddingInline: "0.25rem",
};

export function Pager({ base, page, pages }: { base: string; page: number; pages: number }) {
  if (pages <= 1) return null;
  return (
    <nav
      aria-label="Pages of posts"
      className="oks-pager"
      style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "center" }}
    >
      {page > 1 ? (
        <a href={pagePath(base, page - 1)} rel="prev" style={LINK}>
          Newer posts
        </a>
      ) : null}
      <span>{`Page ${page} of ${pages}`}</span>
      {page < pages ? (
        <a href={pagePath(base, page + 1)} rel="next" style={LINK}>
          Older posts
        </a>
      ) : null}
    </nav>
  );
}
