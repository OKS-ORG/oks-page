"use client";
// The Look screen: one main color, a font for the text and one for the headings, and the logo. A small sample on the page
// shows the choice before it is saved. The server checks every value again.
import {
  COLOR_STEPS,
  colorScale,
  FONT_STACKS,
  type FontChoice,
  type ThemeStyles,
} from "@oks-page/core/theme";
import { Alert, Button } from "oks-ui";
import { useState, type CSSProperties, type FormEvent } from "react";
import { MediaPicker } from "./media-picker";

export interface LogoPreview {
  url: string;
  alt: string;
}

const FONT_LABELS: Record<FontChoice, string> = {
  "system-sans": "Clean sans-serif",
  "system-serif": "Classic serif",
  "system-mono": "Typewriter (monospace)",
};
const BUILT_IN_COLOR = "#2563eb";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

export function LookForm({ initial, logo }: { initial: ThemeStyles; logo: LogoPreview | null }) {
  const [color, setColor] = useState<string | null>(initial.mainColor);
  const [bodyFont, setBodyFont] = useState<FontChoice>(initial.bodyFont);
  const [headingFont, setHeadingFont] = useState<FontChoice>(initial.headingFont);
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
        body: JSON.stringify({ mainColor: color, logoMediaId: logoId, bodyFont, headingFont }),
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
    fontFamily: FONT_STACKS[bodyFont],
    border: "1px solid currentColor",
    padding: "1rem",
    maxInlineSize: "32rem",
  };
  const solid = scale ? scale[700] : "#1d4ed8";

  return (
    <form className="oks-look" onSubmit={(event) => void save(event)}>
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
              onChange={(event) => set(event.target.value as FontChoice)}
            >
              {(Object.keys(FONT_STACKS) as FontChoice[]).map((key) => (
                <option key={key} value={key}>
                  {FONT_LABELS[key]}
                </option>
              ))}
            </select>
          </p>
        ))}
        <p>These are fonts every device already has, so the site stays fast.</p>
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

      <section aria-label="Sample" style={sample}>
        <h2 style={{ fontFamily: FONT_STACKS[headingFont], marginBlockStart: 0 }}>
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
