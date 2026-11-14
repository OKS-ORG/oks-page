"use client";
// Settings > Languages (design batch 5; spec 12): the language of the site's content and its writing direction. Public
// pages declare them, so browsers, screen readers and search engines read the text right. Several languages on one
// site come in a later release.
import type { SiteLanguage, SiteLanguageChoice } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";

export function LanguageSettingsScreen({
  initial,
  languages,
}: {
  initial: SiteLanguage;
  languages: SiteLanguageChoice[];
}) {
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState(initial);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const changed = JSON.stringify(form) !== JSON.stringify(saved);
  const chosen = languages.find((l) => l.tag === form.tag);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/settings/language", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = (await response.json().catch(() => null)) as {
      language?: SiteLanguage;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.language) {
      setNote("");
      setProblem(body?.error?.message ?? "The language could not be saved.");
      return;
    }
    setSaved(body.language);
    setForm(body.language);
    setNote("Language saved. Your site shows the change now.");
  }

  return (
    <form aria-labelledby="language-heading" onSubmit={(event) => void save(event)}>
      <h2 id="language-heading">Languages</h2>
      <p>The language of your site.</p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p>
        <label htmlFor="site-language">Language of your site</label>
        <br />
        <select
          id="site-language"
          value={form.tag}
          onChange={(e) => setForm({ ...form, tag: e.target.value })}
          aria-describedby="site-language-help"
          style={{ minBlockSize: "32px", maxInlineSize: "28rem", inlineSize: "100%" }}
        >
          {languages.some((l) => l.tag === form.tag) ? null : (
            <option value={form.tag}>{form.tag}</option>
          )}
          {languages.map((l) => (
            <option key={l.tag} value={l.tag}>
              {l.native === l.name ? `${l.name} · ${l.tag}` : `${l.name} (${l.native}) · ${l.tag}`}
            </option>
          ))}
        </select>
      </p>
      <p id="site-language-help">
        Used by browsers, screen readers and search engines to read your pages.
      </p>
      <fieldset style={{ border: 0, padding: 0, margin: "1rem 0" }}>
        <legend>
          <strong>Writing direction</strong>
        </legend>
        <label style={{ display: "block", minBlockSize: "24px" }}>
          <input
            type="radio"
            name="direction"
            checked={form.direction === "auto"}
            onChange={() => setForm({ ...form, direction: "auto" })}
          />{" "}
          {`From the language (${chosen?.rtl ? "right to left" : "left to right"})`}
        </label>
        <label style={{ display: "block", minBlockSize: "24px" }}>
          <input
            type="radio"
            name="direction"
            checked={form.direction === "ltr"}
            onChange={() => setForm({ ...form, direction: "ltr" })}
          />{" "}
          Always left to right
        </label>
        <label style={{ display: "block", minBlockSize: "24px" }}>
          <input
            type="radio"
            name="direction"
            checked={form.direction === "rtl"}
            onChange={() => setForm({ ...form, direction: "rtl" })}
          />{" "}
          Always right to left
        </label>
      </fieldset>
      <p>
        One language per site for now. Pages and posts in several languages, with a language menu
        for visitors, come in a later release. The admin stays in English.
      </p>
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
