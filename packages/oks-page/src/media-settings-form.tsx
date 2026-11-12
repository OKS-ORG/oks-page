"use client";
// The form of the media settings: the biggest file, the biggest picture, and whether photo details are kept.
import type { MediaSettingsForm } from "@oks-page/core";
import { Alert, Button, RadioGroupField, TextField } from "oks-ui";
import { useState } from "react";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

export function MediaSettingsFormScreen({ initial }: { initial: MediaSettingsForm }) {
  const [megabytes, setMegabytes] = useState(String(initial.maxMegabytes));
  const [megapixels, setMegapixels] = useState(String(initial.maxMegapixels));
  const [keep, setKeep] = useState(initial.keepMetadata ? "keep" : "remove");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch("/api/admin/settings/media", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          maxMegabytes: Number(megabytes),
          maxMegapixels: Number(megapixels),
          keepMetadata: keep === "keep",
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(body, "It could not be saved."));
      setNote("Saved. The new limits count from the next upload.");
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  return (
    <form
      className="oks-media-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <TextField
        name="maxMegabytes"
        label="Biggest file (MB)"
        description="Bigger files are refused. Your host may have its own, lower limit."
        value={megabytes}
        onChange={setMegabytes}
        inputMode="decimal"
      />
      <TextField
        name="maxMegapixels"
        label="Biggest picture (megapixels)"
        description="A picture with more pixels than this is refused. A 12 megapixel photo is 4000 × 3000."
        value={megapixels}
        onChange={setMegapixels}
        inputMode="decimal"
      />
      <RadioGroupField
        name="keepMetadata"
        label="Photo details (where and with which camera a photo was taken)"
        options={[
          { label: "Remove them (better for privacy)", value: "remove" },
          { label: "Keep them", value: "keep" },
        ]}
        value={keep}
        onChange={(value: string) => setKeep(value)}
      />
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
