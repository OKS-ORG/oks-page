"use client";
// Settings > Reading (design batch 5): what the home page shows, the page that lists your posts, how many posts a list
// shows, and what feeds carry. One Save button, enabled once something changed.
import type { PageChoice, ReadingSettings } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";

const ROW: React.CSSProperties = { margin: "0.75rem 0" };
const FIELD: React.CSSProperties = {
  minBlockSize: "32px",
  maxInlineSize: "28rem",
  inlineSize: "100%",
};

export function ReadingSettingsScreen({
  initial,
  pages,
}: {
  initial: ReadingSettings;
  pages: PageChoice[];
}) {
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState(initial);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const changed = JSON.stringify(form) !== JSON.stringify(saved);
  const set = <K extends keyof ReadingSettings>(key: K, value: ReadingSettings[K]) =>
    setForm({ ...form, [key]: value });

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/settings/reading", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = (await response.json().catch(() => null)) as {
      settings?: ReadingSettings;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.settings) {
      setNote("");
      setProblem(body?.error?.message ?? "The settings could not be saved.");
      return;
    }
    setSaved(body.settings);
    setForm(body.settings);
    setNote("Reading settings saved. Your site shows the change now.");
  }

  return (
    <form aria-labelledby="reading-heading" onSubmit={(event) => void save(event)}>
      <h2 id="reading-heading">Reading</h2>
      <p>What visitors see first, and how lists and feeds show your posts.</p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}

      <fieldset style={{ border: 0, padding: 0, margin: "1rem 0" }}>
        <legend>
          <strong>Your home page shows</strong>
        </legend>
        <label style={{ display: "block", minBlockSize: "24px" }}>
          <input
            type="radio"
            name="home-shows"
            checked={form.homeShows === "posts"}
            onChange={() => set("homeShows", "posts")}
          />{" "}
          Your latest posts
        </label>
        <label style={{ display: "block", minBlockSize: "24px" }}>
          <input
            type="radio"
            name="home-shows"
            checked={form.homeShows === "page"}
            onChange={() => set("homeShows", "page")}
          />{" "}
          A page you choose
        </label>
      </fieldset>
      {form.homeShows === "page" ? (
        <div style={ROW}>
          <label htmlFor="reading-home">Home page</label>
          <br />
          <select
            id="reading-home"
            value={form.homePageId ?? ""}
            onChange={(e) => set("homePageId", e.target.value || null)}
            style={FIELD}
          >
            <option value="">The page at the address &quot;home&quot;</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title || p.slug}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div style={ROW}>
        <label htmlFor="reading-posts">Posts page</label>
        <br />
        <select
          id="reading-posts"
          value={form.postsPageId ?? ""}
          onChange={(e) => set("postsPageId", e.target.value || null)}
          aria-describedby="reading-posts-help"
          style={FIELD}
        >
          <option value="">None</option>
          {pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || p.slug}
            </option>
          ))}
        </select>
        <p id="reading-posts-help">Your posts are listed on this page, in place of its own text.</p>
      </div>

      <h3>Lists</h3>
      <div style={ROW}>
        <label htmlFor="reading-per-page">Posts per page</label>
        <br />
        <input
          id="reading-per-page"
          type="number"
          min={1}
          max={50}
          value={form.perPage}
          onChange={(e) => set("perPage", Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
          style={{ ...FIELD, maxInlineSize: "8rem" }}
        />
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: "1rem 0" }}>
        <legend>
          <strong>Feeds show</strong>
        </legend>
        <label style={{ display: "block", minBlockSize: "24px" }}>
          <input
            type="radio"
            name="feed-text"
            checked={form.feedFullText}
            onChange={() => set("feedFullText", true)}
          />{" "}
          The full text
        </label>
        <label style={{ display: "block", minBlockSize: "24px" }}>
          <input
            type="radio"
            name="feed-text"
            checked={!form.feedFullText}
            onChange={() => set("feedFullText", false)}
          />{" "}
          A summary
        </label>
      </fieldset>

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
