"use client";
// Settings > General, the site icon (design batch 5): the small picture in the browser tab, chosen from the media library or
// uploaded there. Square, at least 512 × 512; the server checks it.
import { Alert, Button } from "oks-ui";
import { useState } from "react";
import { MediaPicker } from "./media-picker";

export function SiteIconScreen({ initial }: { initial: { url: string; width: number } | null }) {
  const [icon, setIcon] = useState(initial);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(mediaId: string | null) {
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/settings/site-icon", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId }),
    });
    const body = (await response.json().catch(() => null)) as {
      icon?: { url: string; width: number } | null;
      error?: { message?: string };
    } | null;
    if (!response.ok || body?.icon === undefined) {
      setNote("");
      setProblem(body?.error?.message ?? "The site icon could not be saved.");
      return;
    }
    setIcon(body.icon);
    setNote(body.icon ? "Site icon saved. Browser tabs show it now." : "The site icon is removed.");
  }

  return (
    <section aria-labelledby="general-icon">
      <h2 id="general-icon">Site icon</h2>
      <p>The small picture in the browser tab. Square, at least 512 × 512 pixels.</p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      {icon ? (
        <p>
          <img src={icon.url} alt="Your site icon" width={64} height={64} />
        </p>
      ) : (
        <p>No site icon yet.</p>
      )}
      <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <Button onPress={() => setPicking(true)}>{icon ? "Replace" : "Choose a site icon"}</Button>
        {icon ? <Button onPress={() => void save(null)}>Remove the site icon</Button> : null}
      </p>
      <p role="status">{note}</p>
      <MediaPicker
        isOpen={picking}
        onClose={() => setPicking(false)}
        title="Choose a site icon from the library"
        pickLabel="Use as site icon"
        onPick={(item) => {
          setPicking(false);
          void save(item.id);
        }}
      />
    </section>
  );
}
