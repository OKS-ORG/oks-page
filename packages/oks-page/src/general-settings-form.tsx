"use client";
// The general settings form: the site's name, its tagline and its time zone.
import type { GeneralSettings } from "@oks-page/core";
import { formatInZone } from "@oks-page/core/timezone";
import { Alert, Button, TextField } from "oks-ui";
import { useState, type FormEvent } from "react";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

export function GeneralSettingsFormScreen({
  initial,
  zones,
}: {
  initial: GeneralSettings;
  /** Every time zone name the site can use. */
  zones: string[];
}) {
  const [siteName, setSiteName] = useState(initial.siteName);
  const [tagline, setTagline] = useState(initial.tagline);
  const [zone, setZone] = useState(initial.timeZone ?? "");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch("/api/admin/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteName, tagline, timeZone: zone === "" ? null : zone }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(body, "It could not be saved."));
      const saved = (body as { settings: GeneralSettings }).settings;
      setSiteName(saved.siteName);
      setTagline(saved.tagline);
      setNote("Saved.");
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  return (
    <form className="oks-general-settings" onSubmit={(event) => void save(event)}>
      <TextField
        name="siteName"
        label="Site name"
        required
        value={siteName}
        onChange={setSiteName}
        maxLength={100}
      />
      <TextField
        name="tagline"
        label="Tagline"
        description="A few words about the site."
        value={tagline}
        onChange={setTagline}
        maxLength={200}
      />
      <p>
        <label htmlFor="general-zone">Time zone</label>
        <br />
        <select
          id="general-zone"
          value={zone}
          style={{ minBlockSize: "36px", maxWidth: "100%" }}
          onChange={(event) => setZone(event.target.value)}
        >
          <option value="">Automatic (each person’s own browser)</option>
          {zones.map((name) => (
            <option key={name} value={name}>
              {name.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </p>
      <p>
        {zone
          ? `It is ${formatInZone(Date.now(), zone, { dateStyle: "medium", timeStyle: "short" })} there now. `
          : ""}
        The time to publish a page, and the dates the admin shows, use this time zone.
      </p>
      <p>
        <Button color="primary" type="submit">
          Save settings
        </Button>
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p role="status">{note}</p>
    </form>
  );
}
