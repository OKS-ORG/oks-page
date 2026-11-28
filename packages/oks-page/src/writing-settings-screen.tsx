"use client";
// Settings > Writing (design batch 5): what a new post starts with. The comment settings of the design come with comments
// (M3), and the accessibility check while writing comes with the editor work.
import type { LayoutChoice, WritingSettings } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";
import { SaveBar, SettingRow, SettingsCard } from "./settings-rows";

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
    <form
      className="oks-set-form"
      aria-labelledby="writing-heading"
      onSubmit={(event) => void save(event)}
    >
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <SettingsCard
        title="New posts"
        titleId="writing-heading"
        line="Defaults for new posts. A post can always be changed on its own edit screen."
      >
        <SettingRow label="Default category" htmlFor="writing-category">
          <select
            id="writing-category"
            value={form.defaultCategoryId ?? ""}
            onChange={(e) => setForm({ ...form, defaultCategoryId: e.target.value || null })}
          >
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label="Default layout"
          htmlFor="writing-layout"
          helpId="writing-layout-help"
          help={
            layouts.length === 0
              ? "Layouts you make for pages to choose show here too (Settings, Site editor, New layout)."
              : "Layouts you made in the site editor can be chosen here."
          }
        >
          <select
            id="writing-layout"
            value={form.defaultLayout}
            onChange={(e) => setForm({ ...form, defaultLayout: e.target.value })}
            aria-describedby="writing-layout-help"
          >
            <option value="">Post (the usual layout)</option>
            {layouts.map((l) => (
              <option key={l.name} value={l.name}>
                {l.title}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingsCard>
      <p>Comments come in a later release; their settings will be on this page.</p>
      <SaveBar note={changed ? "You have unsaved changes." : note || "No changes."}>
        <Button type="submit" color="primary" isDisabled={!changed}>
          Save changes
        </Button>
      </SaveBar>
    </form>
  );
}
