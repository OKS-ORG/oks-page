"use client";
// The maintenance settings form: on or off, and the message visitors see.
import type { MaintenanceSettings } from "@oks-page/core";
import { Alert, Button, RadioGroupField } from "oks-ui";
import { useState, type FormEvent } from "react";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

export function MaintenanceSettingsFormScreen({ initial }: { initial: MaintenanceSettings }) {
  const [mode, setMode] = useState(initial.enabled ? "on" : "off");
  const [message, setMessage] = useState(initial.message);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch("/api/admin/settings/maintenance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: mode === "on", message }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(body, "It could not be saved."));
      const saved = (body as { settings: MaintenanceSettings }).settings;
      setMessage(saved.message);
      setNote(
        saved.enabled
          ? "Saved. Visitors now see the maintenance page. You still see the real site while you are signed in."
          : "Saved. The site is open to everyone.",
      );
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  return (
    <form className="oks-maintenance-settings" onSubmit={(event) => void save(event)}>
      <RadioGroupField
        name="maintenance"
        label="Maintenance mode"
        options={[
          { label: "Off: the site is open to everyone", value: "off" },
          {
            label:
              "On: visitors see a maintenance page; administrators who are signed in see the site",
            value: "on",
          },
        ]}
        value={mode}
        onChange={(value: string) => setMode(value)}
      />
      <p>
        <label htmlFor="maintenance-message">Message for visitors</label>
        <br />
        <textarea
          id="maintenance-message"
          name="message"
          rows={4}
          maxLength={500}
          style={{ width: "100%", maxWidth: "40rem" }}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
      </p>
      <p>
        While it is on, search engines are told to come back later (status 503), and the sign-in
        page and the admin stay open so you can turn it off. A site made as plain files (static
        export) has no server, so this does not apply to it.
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
