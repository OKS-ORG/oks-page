"use client";
// Settings > Screen sizes: which of the seven screen sizes the site designs for, with the widths each one covers. The
// smallest (phone) is always on. One Save button, enabled once something changed.
import { BREAKPOINTS, screenSizesOf } from "@oks-page/content-safety";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";

const same = (a: string[], b: string[]) => a.join() === b.join();

export function ScreenSizesScreen({ initial }: { initial: string[] }) {
  const [saved, setSaved] = useState(initial);
  const [on, setOn] = useState(initial);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const changed = !same(on, saved);
  const ranges = screenSizesOf(on);
  const rangeOf = (name: string) => ranges.find((r) => r.name === name);

  const toggle = (name: string, value: boolean) =>
    setOn(
      BREAKPOINTS.filter((b) => (b.name === name ? value : on.includes(b.name))).map((b) => b.name),
    );

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/settings/screens", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sizes: on }),
    });
    const body = (await response.json().catch(() => null)) as {
      sizes?: string[];
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.sizes) {
      setNote("");
      setProblem(body?.error?.message ?? "The screen sizes could not be saved.");
      return;
    }
    setSaved(body.sizes);
    setOn(body.sizes);
    setNote("Screen sizes saved. Your site shows the change now.");
  }

  return (
    <form aria-labelledby="screens-heading" onSubmit={(event) => void save(event)}>
      <h2 id="screens-heading">Screen sizes</h2>
      <p>
        Choose the screen sizes you design for in the layout editor. Phone is always on. Each size
        you switch on covers the widths shown next to it, up to the next size that is on, so there
        is never a gap.
      </p>
      <p>
        A style you set for a size that is off is not shown. A page keeps it until the page is saved
        again, so switching the size back on brings it back.
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <fieldset style={{ border: 0, padding: 0, margin: "1rem 0" }}>
        <legend>
          <strong>Sizes you design for</strong>
        </legend>
        {BREAKPOINTS.map((b) => {
          const range = rangeOf(b.name);
          const label = screenSizesOf(BREAKPOINTS.map((x) => x.name)).find(
            (r) => r.name === b.name,
          )!.label;
          return (
            <label key={b.name} style={{ display: "block", minBlockSize: "32px" }}>
              <input
                type="checkbox"
                checked={b.name === "base" || on.includes(b.name)}
                disabled={b.name === "base"}
                onChange={(event) => toggle(b.name, event.target.checked)}
              />{" "}
              {label}
              {range
                ? range.to === null
                  ? `: ${range.from} px and wider`
                  : `: ${range.from} to ${range.to} px`
                : ": off"}
            </label>
          );
        })}
      </fieldset>
      <p style={{ minBlockSize: "1.5rem" }} role="status">
        {note}
      </p>
      <Button type="submit" isDisabled={!changed}>
        Save screen sizes
      </Button>
    </form>
  );
}
