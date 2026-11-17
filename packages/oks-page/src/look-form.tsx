"use client";
// The Look screen: one main color, a font for the text and one for the headings, and the logo. A small sample on the page
// shows the choice before it is saved. The server checks every value again.
import {
  COLOR_STEPS,
  colorScale,
  COLOR_MODES,
  FONT_LIBRARY,
  FONT_STACKS,
  fontByKey,
  fontFaceCss,
  fontStack,
  LICENSE_NAME,
  LICENSE_URL,
  type ColorMode,
  type FontKind,
  type LibraryFont,
  type ThemeStyles,
} from "@oks-page/core/theme";
import type { ContrastWarning } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState, type CSSProperties, type FormEvent } from "react";
import { MediaPicker } from "./media-picker";

/** What the form shows of a font the owner uploaded. */
export interface OwnerFontView {
  key: string;
  name: string;
  kind: FontKind;
  weight: string;
  bytes: number;
}

const WEIGHT_LABELS: Record<string, string> = {
  "400": "Regular",
  "700": "Bold",
  vf: "Every weight (variable font)",
};

export interface LogoPreview {
  url: string;
  alt: string;
}

const SYSTEM_LABELS = {
  "system-sans": "Clean sans-serif",
  "system-serif": "Classic serif",
  "system-mono": "Typewriter (monospace)",
} as const;
const MODE_LABELS: Record<ColorMode, string> = {
  light: "Always light",
  dark: "Always dark",
  system: "Like the visitor's device (light or dark)",
};
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

export function LookForm({
  initial,
  logo,
  warnings = [],
  ownerFonts: ownerFontsAtStart = [],
}: {
  initial: ThemeStyles;
  logo: LogoPreview | null;
  warnings?: ContrastWarning[];
  ownerFonts?: OwnerFontView[];
}) {
  const [ownFonts, setOwnFonts] = useState<OwnerFontView[]>(ownerFontsAtStart);
  const [fontNote, setFontNote] = useState("");
  const [fontProblem, setFontProblem] = useState<string | null>(null);
  const [fontName, setFontName] = useState("");
  const [fontKind, setFontKind] = useState<FontKind>("sans");
  const [fontWeight, setFontWeight] = useState("400");
  const [fontLicence, setFontLicence] = useState(false);
  const [fontFile, setFontFile] = useState<File | null>(null);
  const [fontFileKey, setFontFileKey] = useState(0);

  async function addFont() {
    setFontProblem(null);
    setFontNote("Adding the font…");
    const data = new FormData();
    if (fontFile) data.append("file", fontFile);
    data.append("name", fontName);
    data.append("kind", fontKind);
    data.append("weight", fontWeight);
    data.append("licence", String(fontLicence));
    try {
      const response = await fetch("/api/admin/fonts", { method: "POST", body: data });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(body, "The font could not be added."));
      const font = (body as { font: OwnerFontView }).font;
      setOwnFonts((list) => [...list, font]);
      setFontNote(`${font.name} is added. Choose it in the lists above, then save.`);
      setFontName("");
      setFontLicence(false);
      setFontFile(null);
      setFontFileKey((n) => n + 1);
    } catch (error) {
      setFontNote("");
      setFontProblem((error as Error).message);
    }
  }

  async function removeFont(font: OwnerFontView) {
    setFontProblem(null);
    setFontNote("");
    const response = await fetch(`/api/admin/fonts/${encodeURIComponent(font.key)}`, {
      method: "DELETE",
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setFontProblem(failure(body, "The font could not be removed."));
      return;
    }
    setOwnFonts((list) => list.filter((f) => f.key !== font.key));
    setFontNote(`${font.name} is removed.`);
  }
  const [color, setColor] = useState<string | null>(initial.mainColor);
  const [bodyFont, setBodyFont] = useState<string>(initial.bodyFont);
  const [headingFont, setHeadingFont] = useState<string>(initial.headingFont);
  const [colorMode, setColorMode] = useState<ColorMode>(initial.colorMode);
  const [modeSwitch, setModeSwitch] = useState(initial.modeSwitch);
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
          colorMode,
          modeSwitch,
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
    <>
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
            The other shades are made from it. Button text stays easy to read, in light and dark
            mode.
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
                {ownFonts.length > 0 ? (
                  <optgroup label="Your own fonts">
                    {ownFonts.map((font) => (
                      <option key={font.key} value={font.key}>
                        {`${font.name} (${WEIGHT_LABELS[font.weight] ?? font.weight})`}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
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
          <legend>Light and dark</legend>
          {COLOR_MODES.map((mode) => (
            <p key={mode} style={{ margin: "0.25rem 0" }}>
              <label style={{ display: "inline-block", minBlockSize: "24px" }}>
                <input
                  type="radio"
                  name="look-color-mode"
                  value={mode}
                  checked={colorMode === mode}
                  onChange={() => setColorMode(mode)}
                />{" "}
                {MODE_LABELS[mode]}
              </label>
            </p>
          ))}
          <p>
            <label style={{ display: "inline-block", minBlockSize: "24px" }}>
              <input
                type="checkbox"
                checked={modeSwitch}
                onChange={(event) => setModeSwitch(event.target.checked)}
              />{" "}
              Show visitors a switch to choose light or dark for themselves
            </label>
          </p>
          {warnings
            .filter((w) => colorMode === "system" || w.mode === (colorMode as string))
            .map((w) => (
              <Alert
                key={`${w.mode}-${w.part}`}
                color="warning"
                title="Hard to read"
                description={`${w.message} Change the theme's colors, or choose another look. You can still save.`}
              />
            ))}
          <p>
            A visitor's choice is kept only in their own browser and is never sent to anyone. No
            cookie is set.
          </p>
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
            allowed: @import, addresses of other sites, scripts, and anything that could break out
            of the style tag. Images can only be small PNG, JPEG, GIF, WebP or AVIF files written
            into the CSS.
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
      <section aria-label="Your own fonts" className="oks-own-fonts">
        <h2 style={{ fontSize: "1.125rem" }}>Your own fonts</h2>
        <p>
          Add a font file (.woff2) and it is kept on your own site and shown from there, like the
          fonts of the library. You can keep up to 6 fonts, each up to 400 KB. Only add a font you
          have the right to use on a website.
        </p>
        {ownFonts.length > 0 ? (
          <ul>
            {ownFonts.map((font) => (
              <li key={font.key}>
                {`${font.name}: ${KIND_LABELS[font.kind]}, ${WEIGHT_LABELS[font.weight] ?? font.weight}, ${Math.max(1, Math.round(font.bytes / 1000))} KB. `}
                <Button size="sm" onPress={() => void removeFont(font)}>
                  {`Remove ${font.name}`}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p>You have not added a font of your own yet.</p>
        )}
        <p>
          <label htmlFor="own-font-file">Font file (.woff2)</label>
          <br />
          <input
            key={fontFileKey}
            id="own-font-file"
            type="file"
            accept=".woff2,font/woff2"
            onChange={(event) => setFontFile(event.target.files?.[0] ?? null)}
          />
        </p>
        <p>
          <label htmlFor="own-font-name">Name of the font</label>
          <br />
          <input
            id="own-font-name"
            type="text"
            maxLength={40}
            value={fontName}
            style={{ minBlockSize: "36px" }}
            onChange={(event) => setFontName(event.target.value)}
          />
        </p>
        <p>
          <label htmlFor="own-font-kind">What kind of font is it</label>
          <br />
          <select
            id="own-font-kind"
            value={fontKind}
            style={{ minBlockSize: "36px" }}
            onChange={(event) => setFontKind(event.target.value as FontKind)}
          >
            {(Object.keys(KIND_LABELS) as FontKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="own-font-weight">Which weight does the file have</label>
          <br />
          <select
            id="own-font-weight"
            value={fontWeight}
            style={{ minBlockSize: "36px" }}
            onChange={(event) => setFontWeight(event.target.value)}
          >
            {Object.entries(WEIGHT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="own-font-licence">
            <input
              id="own-font-licence"
              type="checkbox"
              checked={fontLicence}
              onChange={(event) => setFontLicence(event.target.checked)}
            />{" "}
            I have the right to use this font on my site
          </label>
        </p>
        <p>
          <Button color="primary" onPress={() => void addFont()}>
            Add the font
          </Button>
        </p>
        <p role="status">{fontNote}</p>
        {fontProblem ? (
          <Alert color="danger" title="The font was not added" description={fontProblem} />
        ) : null}
      </section>
    </>
  );
}
