"use client";
// The "Layout" box on the edit screen (spec 05, section 17.6): a page can choose one of the layouts the owner made for
// pages to choose ("Landing page"), or its usual layout. It saves on its own button, so it does not make a new copy of
// the text. The box shows only when the theme in use has such layouts.
import { Alert, Button } from "oks-ui";
import { useEffect, useState, type FormEvent } from "react";

interface Choice {
  name: string;
  title: string;
}

export function EntryLayoutPanel({ id }: { id: string }) {
  const [layout, setLayout] = useState("");
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/admin/entries/${id}/layout`)
      .then((r) => r.json())
      .then((body: { layout?: string; choices?: Choice[] }) => {
        if (!live || !body.choices) return;
        setLayout(body.layout ?? "");
        setChoices(body.choices);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch(`/api/admin/entries/${id}/layout`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout }),
      });
      const body = (await response.json().catch(() => null)) as {
        layout?: string;
        error?: { message?: string };
      } | null;
      if (!response.ok || body?.layout === undefined)
        throw new Error(body?.error?.message ?? "It could not be saved.");
      setNote("Layout saved. The page uses it now.");
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  // Nothing to choose (no layouts made for pages, or a chosen one that is gone): the box stays out of the way.
  if (!choices || (choices.length === 0 && !layout)) return null;
  return (
    <form aria-labelledby="layout-heading" onSubmit={(event) => void save(event)}>
      <h2 id="layout-heading">Layout</h2>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p>
        <label htmlFor="entry-layout">How this page is laid out</label>
        <br />
        <select
          id="entry-layout"
          value={layout}
          onChange={(event) => setLayout(event.target.value)}
          style={{ minBlockSize: "32px" }}
        >
          <option value="">Default (the usual layout)</option>
          {choices.map((c) => (
            <option key={c.name} value={c.name}>
              {c.title}
            </option>
          ))}
        </select>
      </p>
      <p>
        <Button type="submit">Update the layout</Button>
      </p>
      <p role="status">{note}</p>
    </form>
  );
}
