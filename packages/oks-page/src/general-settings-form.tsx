"use client";
// The general settings form: the site's name, its tagline and its time zone.
import type { GeneralSettings } from "@oks-page/core";
import { formatInZone } from "@oks-page/core/timezone";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";
import { SaveBar, SettingRow, SettingsCard } from "./settings-rows";
import { useInBrowser } from "./time-format";

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
  const inBrowser = useInBrowser();

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
    <form className="oks-general-settings oks-set-form" onSubmit={(event) => void save(event)}>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <SettingsCard title="Site identity">
        <SettingRow label="Site name" htmlFor="general-name">
          <input
            id="general-name"
            name="siteName"
            type="text"
            required
            maxLength={100}
            value={siteName}
            onChange={(event) => setSiteName(event.target.value)}
          />
        </SettingRow>
        <SettingRow
          label="Tagline"
          htmlFor="general-tagline"
          help="A few words about the site."
          helpId="general-tagline-help"
        >
          <input
            id="general-tagline"
            name="tagline"
            type="text"
            maxLength={200}
            value={tagline}
            aria-describedby="general-tagline-help"
            onChange={(event) => setTagline(event.target.value)}
          />
        </SettingRow>
        <SettingRow
          label="Time zone"
          htmlFor="general-zone"
          help="The time to publish a page, and the dates the admin shows, use this time zone."
        >
          <select id="general-zone" value={zone} onChange={(event) => setZone(event.target.value)}>
            <option value="">Automatic (each person’s own browser)</option>
            {zones.map((name) => (
              <option key={name} value={name}>
                {name.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          {zone && inBrowser ? (
            <p>{`It is ${formatInZone(Date.now(), zone, { dateStyle: "medium", timeStyle: "short" })} there now.`}</p>
          ) : null}
        </SettingRow>
      </SettingsCard>
      <SaveBar note={note}>
        <Button color="primary" type="submit">
          Save settings
        </Button>
      </SaveBar>
    </form>
  );
}
