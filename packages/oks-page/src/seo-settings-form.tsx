"use client";
// The search-engines settings form: whether search engines are asked to stay away from the site.
import type { SeoSettings } from "@oks-page/core";
import { Alert, Button, RadioGroupField } from "oks-ui";
import { useState, type FormEvent } from "react";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

export function SeoSettingsFormScreen({ initial }: { initial: SeoSettings }) {
  const [mode, setMode] = useState(initial.discourageIndexing ? "closed" : "open");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch("/api/admin/settings/seo", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ discourageIndexing: mode === "closed" }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(body, "It could not be saved."));
      setNote(
        mode === "closed"
          ? "Saved. Search engines are asked to stay away, and the sitemap is switched off."
          : "Saved. Search engines may index the site, and the sitemap is on.",
      );
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  return (
    <form className="oks-seo-settings" onSubmit={(event) => void save(event)}>
      <RadioGroupField
        name="indexing"
        label="Search engines"
        options={[
          {
            label: "Open: search engines may index the site (robots.txt and the sitemap are on)",
            value: "open",
          },
          {
            label: "Closed: ask search engines to stay away (for a site that is not ready)",
            value: "closed",
          },
        ]}
        value={mode}
        onChange={(value: string) => setMode(value)}
      />
      <p>
        Closed adds <code>Disallow: /</code> to robots.txt, switches the sitemap off and sends{" "}
        <code>noindex, nofollow</code> with every page. It is a request: well-behaved search engines
        follow it, but it does not hide the site. Use maintenance mode or a password to keep people
        out.
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
