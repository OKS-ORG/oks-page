"use client";
// The switch visitors use to choose light or dark for themselves (only when the owner turned it on). The choice is kept
// in the visitor's own browser, under one name, and goes nowhere else.
import { COLOR_MODE_STORAGE_KEY } from "@oks-page/core/theme";
import { useEffect, useState } from "react";

export function ColorModeSwitch() {
  const [dark, setDark] = useState(false);
  // The script has set the mode before the page was drawn; the button only reads it.
  useEffect(() => setDark(document.documentElement.dataset["theme"] === "dark"), []);
  return (
    <p className="oks-color-mode" style={{ textAlign: "end", margin: 0 }}>
      <button
        type="button"
        aria-pressed={dark}
        style={{ minBlockSize: "24px", minInlineSize: "24px", cursor: "pointer" }}
        onClick={() => {
          const next = dark ? "light" : "dark";
          document.documentElement.setAttribute("data-theme", next);
          try {
            localStorage.setItem(COLOR_MODE_STORAGE_KEY, next);
          } catch {
            // Storage may be blocked; the choice then lasts until the page is left.
          }
          setDark(!dark);
        }}
      >
        Dark mode
      </button>
    </p>
  );
}
