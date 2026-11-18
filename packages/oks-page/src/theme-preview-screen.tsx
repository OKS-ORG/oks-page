"use client";
// The preview of a theme on the site's own pages: a page to look at and a width (desktop, tablet, phone). The page is shown
// in a frame, so the width really changes how the theme lays it out.
import { Button } from "oks-ui";
import { useState } from "react";

export interface PreviewPage {
  slug: string;
  title: string;
  post: boolean;
}

const WIDTHS = [
  { key: "desktop", label: "Desktop", width: "100%" },
  { key: "tablet", label: "Tablet", width: "768px" },
  { key: "phone", label: "Phone", width: "390px" },
] as const;

export function ThemePreviewScreen({
  themeId,
  themeName,
  isActive,
  pages,
}: {
  themeId: string;
  themeName: string;
  isActive: boolean;
  pages: PreviewPage[];
}) {
  const [slug, setSlug] = useState(pages[0]?.slug ?? "");
  const [width, setWidth] = useState<(typeof WIDTHS)[number]["key"]>("desktop");
  const chosen = WIDTHS.find((w) => w.key === width)!;
  const src = `/admin/themes/${encodeURIComponent(themeId)}/preview/frame${slug ? `?page=${encodeURIComponent(slug)}` : ""}`;
  return (
    <div>
      <p>
        {isActive
          ? `This is how your pages look now with ${themeName}.`
          : `This is how your own pages would look with ${themeName}. Your site does not change: ${themeName} is not in use.`}
      </p>
      <p style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
        {pages.length > 0 ? (
          <span>
            <label htmlFor="preview-page">Page to look at </label>
            <select id="preview-page" value={slug} onChange={(e) => setSlug(e.target.value)}>
              {pages.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.post ? `Post: ${p.title}` : p.title}
                </option>
              ))}
            </select>
          </span>
        ) : null}
        <span role="group" aria-label="Screen width" style={{ display: "flex", gap: "0.5rem" }}>
          {WIDTHS.map((w) => (
            <Button
              key={w.key}
              aria-pressed={w.key === width}
              color={w.key === width ? "primary" : "default"}
              onPress={() => setWidth(w.key)}
            >
              {w.label}
            </Button>
          ))}
        </span>
        <a href="/admin/settings/themes">Back to the themes</a>
      </p>
      <iframe
        key={`${slug}`}
        title={`${themeName} on your pages, ${chosen.label.toLowerCase()} width`}
        src={src}
        style={{
          inlineSize: chosen.width,
          maxInlineSize: "100%",
          blockSize: "70vh",
          minBlockSize: "480px",
          border: "1px solid currentColor",
          display: "block",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
