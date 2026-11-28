"use client";
// Appearance (docs/18-new-look.md, step 7): the look, light or dark, and the accent colour of the admin, for the signed-in person.
// A choice shows at once and is saved as it is made; "Reset" goes back to the site's default.
import {
  accentAdjusted,
  appearanceCss,
  needsAppearanceCss,
  type Appearance,
  type AppearanceMode,
} from "@oks-page/core/appearance";
import { LOOK_KEYS, LOOKS, type LookKey } from "@oks-page/core/looks";
import { fontFaceCss } from "@oks-page/core/theme";
import { Alert, Button } from "oks-ui";
import { useEffect, useRef, useState } from "react";
import { ChoiceCard } from "./choice-card";

const MODES: { value: AppearanceMode; label: string; note: string }[] = [
  { value: "light", label: "Light", note: "Always light" },
  { value: "dark", label: "Dark", note: "Always dark" },
  { value: "system", label: "Match my device", note: "Follows your device" },
];

/** The colours to pick from; the first is the look's own. */
const ACCENTS: { value: string; label: string }[] = [
  { value: "", label: "The look's own colour" },
  { value: "#0b57d0", label: "Blue" },
  { value: "#0f6b5c", label: "Green" },
  { value: "#c8372d", label: "Red" },
  { value: "#7c3aed", label: "Violet" },
  { value: "#b45309", label: "Amber" },
  { value: "#0e7490", label: "Teal" },
];

const HEX = /^#[0-9a-fA-F]{6}$/;

export function AppearanceScreen({
  initial,
  siteDefault,
}: {
  initial: Appearance;
  siteDefault: Appearance;
}) {
  const [a, setA] = useState(initial);
  const [typed, setTyped] = useState(initial.accent);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const saving = useRef(0);

  // The page itself shows the choice at once: the wrapper takes the look and mode, and the rules for the colours come with this screen.
  useEffect(() => {
    const root = document.querySelector(".oks-admin");
    if (!root) return;
    root.setAttribute("data-look", a.look);
    root.setAttribute("data-mode", a.mode);
    if (needsAppearanceCss(a)) root.setAttribute("data-appearance", "custom");
    else root.removeAttribute("data-appearance");
  }, [a]);

  async function change(patch: Partial<Appearance>) {
    const next = { ...a, ...patch };
    setA(next);
    setProblem(null);
    setStatus(null);
    const ticket = ++saving.current;
    try {
      const response = await fetch("/api/admin/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (ticket !== saving.current) return;
      if (response.ok) setStatus("Saved.");
      else {
        const body = (await response.json().catch(() => null)) as {
          error?: { message: string };
        } | null;
        setProblem(body?.error?.message ?? "It could not be saved. Try again.");
      }
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
  }

  async function reset() {
    const ticket = ++saving.current;
    setProblem(null);
    try {
      const response = await fetch("/api/admin/appearance", { method: "DELETE" });
      if (ticket !== saving.current) return;
      if (!response.ok) {
        setProblem("It could not be reset. Try again.");
        return;
      }
      setA({ ...siteDefault, menuCollapsed: a.menuCollapsed });
      setTyped(siteDefault.accent);
      setStatus("Back to the site's default.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
  }

  function typeColour(value: string) {
    setTyped(value);
    if (HEX.test(value)) void change({ accent: value.toLowerCase() });
  }

  const adjusted = accentAdjusted(a.look, a.accent);
  return (
    <div className="oks-appearance">
      {/* The page came with the fonts of the look it had; a look picked here needs its own at once. */}
      <style
        dangerouslySetInnerHTML={{
          __html: fontFaceCss([
            ...new Set([LOOKS[a.look].fonts.heading, LOOKS[a.look].fonts.text]),
          ]),
        }}
      />
      {needsAppearanceCss(a) ? (
        <style dangerouslySetInnerHTML={{ __html: appearanceCss(a) }} />
      ) : null}
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <fieldset className="oks-choices">
        <legend>Look</legend>
        <div className="oks-choice-grid" data-columns="3">
          {LOOK_KEYS.map((key: LookKey) => {
            const look = LOOKS[key];
            return (
              <ChoiceCard
                key={key}
                name="look"
                value={key}
                checked={a.look === key}
                onChange={(value) => void change({ look: value as LookKey })}
              >
                <span className="oks-look-swatches" aria-hidden="true">
                  <span style={{ background: look.light.ground }} />
                  <span style={{ background: look.light.card }} />
                  <span style={{ background: look.light.accent }} />
                  <span style={{ background: look.dark.ground }} />
                </span>
                <span className="oks-choice-name">{look.name}</span>
              </ChoiceCard>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="oks-choices">
        <legend>Mode</legend>
        <div className="oks-choice-grid" data-columns="3">
          {MODES.map((m) => (
            <ChoiceCard
              key={m.value}
              name="mode"
              value={m.value}
              checked={a.mode === m.value}
              onChange={(value) => void change({ mode: value as AppearanceMode })}
            >
              <span className="oks-choice-name">{m.label}</span>
              <span className="oks-choice-note">{m.note}</span>
            </ChoiceCard>
          ))}
        </div>
      </fieldset>
      <fieldset className="oks-choices">
        <legend>Accent colour</legend>
        <div className="oks-accent-row">
          {ACCENTS.map((c) => (
            <button
              key={c.value || "own"}
              type="button"
              className="oks-accent-dot"
              aria-label={c.label}
              aria-pressed={a.accent === c.value}
              data-own={c.value === "" ? "true" : "false"}
              style={c.value ? { background: c.value } : undefined}
              onClick={() => {
                setTyped(c.value);
                void change({ accent: c.value });
              }}
            />
          ))}
          <label className="oks-accent-type">
            <span>Your own colour</span>
            <input
              type="text"
              value={typed}
              placeholder="#1a5fb4"
              maxLength={7}
              spellCheck={false}
              aria-describedby="accent-help"
              onChange={(event) => typeColour(event.target.value)}
            />
          </label>
        </div>
        <p id="accent-help" className="oks-choice-help">
          {typed !== "" && !HEX.test(typed)
            ? "Write it like #1a5fb4: a # and six letters or digits."
            : adjusted
              ? "Made a little darker or lighter so words stay readable."
              : "Words on it stay readable in light and dark."}
        </p>
      </fieldset>
      <div className="oks-appearance-foot">
        <p role="status" className="oks-appearance-status">
          {status}
        </p>
        <Button onPress={() => void reset()}>Reset to the site default</Button>
      </div>
    </div>
  );
}
