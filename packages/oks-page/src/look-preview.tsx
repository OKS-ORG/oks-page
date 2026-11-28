"use client";
// The live preview of Settings > Look: the real home page of the site in a frame, drawn at the width of a desktop, a tablet or
// a phone and scaled to fit, with the choices that are not saved yet on top of it. Public pages refuse inline styles (their
// content security policy), so the draft is put on them as a style sheet made from the script, and the saved look's own file is
// switched off in the frame only. Nothing is sent to the server.
import { needsColorMode, stylesToCss, type ThemeStyles } from "@oks-page/core/theme";
import { useCallback, useEffect, useRef, useState } from "react";

const WIDTHS = [
  { key: "desktop", label: "Desktop", pixels: 1280 },
  { key: "tablet", label: "Tablet", pixels: 768 },
  { key: "phone", label: "Phone", pixels: 390 },
] as const;
type Width = (typeof WIDTHS)[number]["key"];

export function LookPreview({ styles, version }: { styles: ThemeStyles; version: number }) {
  const [width, setWidth] = useState<Width>("desktop");
  const [box, setBox] = useState({ width: 0, height: 0 });
  const frame = useRef<HTMLIFrameElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const sheets = useRef(new WeakMap<Document, CSSStyleSheet>());

  const draw = useCallback(() => {
    const doc = frame.current?.contentDocument;
    const view = doc?.defaultView;
    // Nothing to draw on yet, or the frame was led to another site.
    if (!doc?.body || !view || view.location.protocol === "about:") return;
    for (const link of doc.querySelectorAll('link[rel="stylesheet"][href^="/site-style/"]'))
      link.setAttribute("media", "not all");
    let sheet = sheets.current.get(doc);
    if (!sheet) {
      // The sheet has to be made by the frame's own window.
      sheet = new (view as Window & typeof globalThis).CSSStyleSheet();
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      sheets.current.set(doc, sheet);
    }
    sheet.replaceSync(stylesToCss(styles));
    if (needsColorMode(styles.colorMode, styles.modeSwitch)) {
      const dark =
        styles.colorMode === "dark" ||
        (styles.colorMode === "system" && view.matchMedia("(prefers-color-scheme: dark)").matches);
      doc.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    } else doc.documentElement.removeAttribute("data-theme");
  }, [styles]);

  useEffect(draw, [draw]);

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const watch = new ResizeObserver(() =>
      setBox({ width: element.clientWidth, height: element.clientHeight }),
    );
    watch.observe(element);
    return () => watch.disconnect();
  }, []);

  const pixels = WIDTHS.find((w) => w.key === width)!.pixels;
  const scale = box.width > 0 ? Math.min(1, box.width / pixels) : 1;

  return (
    <section aria-label="Preview" className="oks-custom-preview">
      <div className="oks-custom-bar">
        <p>
          Preview with your real content. Colours and fonts show here before you save; a new logo
          shows after you save.
        </p>
        <div role="group" aria-label="Preview width" className="oks-custom-widths">
          {WIDTHS.map((w) => (
            <button
              key={w.key}
              type="button"
              aria-pressed={width === w.key}
              onClick={() => setWidth(w.key)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <div ref={holder} className="oks-custom-frame">
        <iframe
          key={version}
          ref={frame}
          src="/"
          title="Preview of your home page"
          onLoad={draw}
          style={{
            inlineSize: pixels,
            blockSize: box.height / scale,
            insetInlineStart: Math.max(0, (box.width - pixels * scale) / 2),
            transform: `scale(${scale})`,
          }}
        />
      </div>
    </section>
  );
}
