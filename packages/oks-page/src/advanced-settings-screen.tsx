"use client";
// Settings > Advanced, the "Speed" part (design batch 5): clear the saved copies of the public pages when a change does
// not show.
import { Alert, Button } from "oks-ui";
import { useState } from "react";
import { formatWhen } from "./time-format";

export function AdvancedSettingsScreen({
  lastCleared,
}: {
  lastCleared: { at: number; by: string } | null;
}) {
  const [cleared, setCleared] = useState(lastCleared);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function clear() {
    setProblem(null);
    setNote("Clearing…");
    const response = await fetch("/api/admin/settings/advanced", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "clear-copies" }),
    });
    const body = (await response.json().catch(() => null)) as {
      at?: number;
      by?: string;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.at) {
      setNote("");
      setProblem(body?.error?.message ?? "The saved copies could not be cleared.");
      return;
    }
    setCleared({ at: body.at, by: body.by ?? "" });
    setNote("The saved copies are cleared. Each page is made fresh at its next visit.");
  }

  return (
    <section aria-labelledby="advanced-speed">
      <h2 id="advanced-speed">Speed</h2>
      <p>
        <strong>Saved copies of pages.</strong> Your site keeps ready copies of pages so they open
        fast, and refreshes them by itself when something changes. Clear them if a change does not
        show.
      </p>
      {problem ? <Alert color="danger" title="Not cleared" description={problem} /> : null}
      <p>
        <Button onPress={() => void clear()}>Clear saved copies</Button>
      </p>
      <p>
        {cleared
          ? `Last cleared by hand ${formatWhen(new Date(cleared.at).toISOString(), null)}${cleared.by ? ` by ${cleared.by}` : ""}.`
          : "Not cleared by hand yet."}
      </p>
      <p role="status">{note}</p>
    </section>
  );
}
