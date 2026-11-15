"use client";
// The Look screen: one main color, a font for the text and one for the headings, and the logo. A small sample on the page
// shows the choice before it is saved. The server checks every value again.
import {
  COLOR_STEPS,
  colorScale,
  FONT_LIBRARY,
  FONT_STACKS,
  fontByKey,
  fontFaceCss,
  fontStack,
  LICENSE_NAME,
  LICENSE_URL,
  type FontKind,
  type LibraryFont,
  type ThemeStyles,
} from "@oks-page/core/theme";
import { Alert, Button } from "oks-ui";
import { useState, type CSSProperties, type FormEvent } from "react";
import { MediaPicker } from "./media-picker";

export interface LogoPreview {
  url: string;
  alt: string;
}

const SYSTEM_LABELS = {
  "system-sans": "Clean sans-serif",
  "system-serif": "Classic serif",
  "system-mono": "Typewriter (monospace)",
} as const;
const KIND_LABELS: Record<FontKind, string> = {
  sans: "Sans-serif fonts",
  serif: "Serif fonts",
  mono: "Monospace fonts",
};
const fontLabel = (font: LibraryFont): string =>
  font.scripts.includes("devanagari") ? `${font.name} (also Hindi)` : font.name;
const BUILT_IN_COLOR = "#2563eb";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

export function LookForm({ initial, logo }: { initial: ThemeStyles; logo: LogoPreview | null }) {
  const [color, setColor] = useState<string | null>(initial.mainColor);
  const [bodyFont, setBodyFont] = useState<string>(initial.bodyFont);
  const [headingFont, setHeadingFont] = useState<string>(initial.headingFont);
  const [customCss, setCustomCss] = useState(initial.customCss);
  const [logoId, setLogoId] = useState<string | null>(initial.logoMediaId);
  const [logoShown, setLogoShown] = useState<LogoPreview | null>(logo);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch("/api/admin/settings/theme", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mainColor: color,
          logoMediaId: logoId,
          customCss,
          bodyFont,
          headingFont,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(body, "It could not be saved."));
      setNote("Saved. Your site shows the new look now.");
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  // The sample uses the same scale the site will use, set on the sample only.
  const scale = colorScale(color ?? BUILT_IN_COLOR);
  const sample: CSSProperties = {
    fontFamily: fontStack(bodyFont),
    border: "1px solid currentColor",
    padding: "1rem",
    maxInlineSize: "32rem",
  };
  const solid = scale ? scale[700] : "#1d4ed8";
  // The fonts of the library in use: their notices, and the rules that let this page show them in the sample.
  const usedFonts = [...new Set([bodyFont, headingFont])]
    .map((key) => fontByKey(key))
    .filter((font): font is LibraryFont => font !== undefined);
  const fontFaces = fontFaceCss([bodyFont, headingFont]);

  return (
    <form className="oks-look" onSubmit={(event) => void save(event)}>
      {fontFaces ? <style>{fontFaces}</style> : null}
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Main color</legend>
        <p>
          <label htmlFor="look-color">Pick the color of links and buttons</label>
          <br />
          <input
            id="look-color"
            type="color"
            value={color ?? BUILT_IN_COLOR}
            style={{ minBlockSize: "36px", minInlineSize: "64px" }}
            onChange={(event) => setColor(event.target.value)}
          />{" "}
          <span>{color ?? "Built-in color"}</span>{" "}
          {color ? <Button onPress={() => setColor(null)}>Use the built-in color</Button> : null}
        </p>
        <p>
          The other shades are made from it. Button text stays easy to read, in light and dark mode.
        </p>
      </fieldset>

      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Fonts</legend>
        {(
          [
            ["look-body-font", "Font for text", bodyFont, setBodyFont],
            ["look-heading-font", "Font for headings", headingFont, setHeadingFont],
          ] as const
        ).map(([id, label, value, set]) => (
          <p key={id}>
            <label htmlFor={id}>{label}</label>
            <br />
            <select
              id={id}
              value={value}
              style={{ minBlockSize: "36px" }}
              onChange={(event) => set(event.target.value)}
            >
              <optgroup label="Fonts every device has">
                {(Object.keys(FONT_STACKS) as (keyof typeof SYSTEM_LABELS)[]).map((key) => (
                  <option key={key} value={key}>
                    {SYSTEM_LABELS[key]}
                  </option>
                ))}
              </optgroup>
              {(Object.keys(KIND_LABELS) as FontKind[]).map((kind) => (
                <optgroup key={kind} label={KIND_LABELS[kind]}>
                  {FONT_LIBRARY.filter((font) => font.kind === kind).map((font) => (
                    <option key={font.key} value={font.key}>
                      {fontLabel(font)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </p>
        ))}
        <p>
          The fonts of the library are kept on your own site and shown from there. Your visitors
          never contact another company, and no cookie is set. A font every device has loads
          fastest.
        </p>
        {usedFonts.length > 0 ? (
          <details>
            <summary style={{ minBlockSize: "24px", lineHeight: "24px" }}>
              Licences of the fonts you use
            </summary>
            <ul>
              {usedFonts.map((font) => (
                <li key={font.key}>
                  {`${font.name} ${font.version}: ${font.copyright}. `}
                  <a href={LICENSE_URL} style={{ display: "inline-block", minBlockSize: "24px" }}>
                    {LICENSE_NAME}
                  </a>
                  .
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </fieldset>

      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Logo</legend>
        {logoShown ? (
          <p>
            <img
              src={logoShown.url}
              alt={`Current logo: ${logoShown.alt || "no description"}`}
              style={{ maxBlockSize: "4rem", maxInlineSize: "16rem" }}
            />
          </p>
        ) : (
          <p>No logo yet. The site shows only its name.</p>
        )}
        <p>
          <Button onPress={() => setPicking(true)}>
            {logoShown ? "Change the logo" : "Choose a logo"}
          </Button>{" "}
          {logoShown ? (
            <Button
              onPress={() => {
                setLogoId(null);
                setLogoShown(null);
              }}
            >
              Remove the logo
            </Button>
          ) : null}
        </p>
        <MediaPicker
          isOpen={picking}
          onClose={() => setPicking(false)}
          title="Choose a logo from the library"
          pickLabel="Use as logo"
          onPick={(item) => {
            setLogoId(item.id);
            setLogoShown({ url: item.url, alt: item.alt });
            setPicking(false);
          }}
        />
      </fieldset>

      <details open={customCss.length > 0}>
        <summary>For developers: your own CSS</summary>
        <p>
          <label htmlFor="look-css">CSS for the public pages</label>
          <br />
          <textarea
            id="look-css"
            rows={10}
            spellCheck={false}
            aria-describedby="look-css-hint"
            style={{
              inlineSize: "100%",
              maxInlineSize: "48rem",
              fontFamily: FONT_STACKS["system-mono"],
              paddingInline: "0.5rem",
            }}
            value={customCss}
            onChange={(event) => setCustomCss(event.target.value)}
          />
        </p>
        <p id="look-css-hint">
          It is checked when you save, and comes after the look above. Up to 50 KB. These are not
          allowed: @import, addresses of other sites, scripts, and anything that could break out of
          the style tag. Images can only be small PNG, JPEG, GIF, WebP or AVIF files written into
          the CSS.
        </p>
      </details>

      <section aria-label="Sample" style={sample}>
        <h2 style={{ fontFamily: fontStack(headingFont), marginBlockStart: 0 }}>
          A heading in your style
        </h2>
        <p>
          Some text in your font, with a{" "}
          <a href="#sample" style={{ color: solid }} onClick={(event) => event.preventDefault()}>
            link in your color
          </a>
          .
        </p>
        <span
          style={{
            display: "inline-block",
            background: solid,
            color: "#ffffff",
            padding: "0.4rem 0.9rem",
            borderRadius: "0.4rem",
          }}
        >
          A button
        </span>
        <p style={{ marginBlockEnd: 0 }}>
          {COLOR_STEPS.map((step) => (
            <span
              key={step}
              aria-hidden="true"
              style={{
                display: "inline-block",
                inlineSize: "1.5rem",
                blockSize: "1.5rem",
                background: scale ? scale[step] : "transparent",
              }}
            />
          ))}
        </p>
      </section>

      <p>
        <Button color="primary" type="submit">
          Save the look
        </Button>
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p role="status">{note}</p>
    </form>
  );
}
