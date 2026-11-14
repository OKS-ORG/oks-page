"use client";
// Settings > Writing (design batch 5): what a new post starts with. The comment settings of the design come with comments
// (M3), and the accessibility check while writing comes with the editor work.
import type { LayoutChoice, WritingSettings } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";

const FIELD: React.CSSProperties = {
  minBlockSize: "32px",
  maxInlineSize: "28rem",
  inlineSize: "100%",
};

export function WritingSettingsScreen({
  initial,
  categories,
  layouts,
}: {
  initial: WritingSettings;
  categories: { id: string; name: string }[];
  layouts: LayoutChoice[];
}) {
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState(initial);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const changed = JSON.stringify(form) !== JSON.stringify(saved);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/settings/writing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = (await response.json().catch(() => null)) as {
      settings?: WritingSettings;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.settings) {
      setNote("");
      setProblem(body?.error?.message ?? "The settings could not be saved.");
      return;
    }
    setSaved(body.settings);
    setForm(body.settings);
    setNote("Writing settings saved. New posts start with them.");
  }

  return (
    <form aria-labelledby="writing-heading" onSubmit={(event) => void save(event)}>
      <h2 id="writing-heading">New posts</h2>
      <p>Defaults for new posts. A post can always be changed on its own edit screen.</p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p>
        <label htmlFor="writing-category">Default category</label>
        <br />
        <select
          id="writing-category"
          value={form.defaultCategoryId ?? ""}
          onChange={(e) => setForm({ ...form, defaultCategoryId: e.target.value || null })}
          style={FIELD}
        >
          <option value="">None</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </p>
      <p>
        <label htmlFor="writing-layout">Default layout</label>
        <br />
        <select
          id="writing-layout"
          value={form.defaultLayout}
          onChange={(e) => setForm({ ...form, defaultLayout: e.target.value })}
          aria-describedby="writing-layout-help"
          style={FIELD}
        >
          <option value="">Post (the usual layout)</option>
          {layouts.map((l) => (
            <option key={l.name} value={l.name}>
              {l.title}
            </option>
          ))}
        </select>
      </p>
      <p id="writing-layout-help">
        {layouts.length === 0
          ? "Layouts you make for pages to choose show here too (Settings, Site editor, New layout)."
          : "Layouts you made in the site editor can be chosen here."}
      </p>
      <p>Comments come in a later release; their settings will be on this page.</p>
      <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
        <span>{changed ? "You have unsaved changes." : "No changes."}</span>
        <Button type="submit" color="primary" isDisabled={!changed}>
          Save changes
        </Button>
      </p>
      <p role="status">{note}</p>
    </form>
  );
}
