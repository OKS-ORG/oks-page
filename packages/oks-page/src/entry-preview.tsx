"use client";
// The "Preview" box on the edit screen: open the saved version on the real site, or make a link that expires.
import { Alert, Button } from "oks-ui";
import { useState } from "react";

const DAYS = [1, 7, 14, 30];

// A row of controls that wraps on a phone, with room between them, and controls that are easy to hit (WCAG 2.2, target
// size: at least 24 px, and not too close to each other).
const ROW: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.75rem",
  margin: "0.75rem 0",
};
const CONTROL: React.CSSProperties = { minBlockSize: "36px", paddingInline: "0.5rem" };

export function EntryPreview({ id }: { id: string }) {
  const [days, setDays] = useState("7");
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function make() {
    setProblem(null);
    setNote("");
    try {
      const response = await fetch(`/api/admin/entries/${id}/preview-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: Number(days) }),
      });
      const body = (await response.json().catch(() => null)) as {
        url?: string;
        expiresAt?: string;
        error?: { message?: string };
      } | null;
      if (!response.ok || !body?.url || !body.expiresAt)
        throw new Error(body?.error?.message ?? "The link could not be made.");
      setLink({ url: body.url, expiresAt: body.expiresAt });
    } catch (error) {
      setLink(null);
      setProblem((error as Error).message);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setNote("Copied.");
    } catch {
      setNote("It could not be copied. Select the link and copy it by hand.");
    }
  }

  return (
    <section aria-labelledby="preview-heading">
      <h2 id="preview-heading">Preview</h2>
      <p>
        <a href={`/preview/${id}`} target="_blank" rel="noopener">
          Open a preview (opens in a new tab)
        </a>{" "}
        It shows the last saved version on the real site. Save first to see your latest changes.
      </p>
      <div style={ROW}>
        <label htmlFor="preview-days">Share link lasts</label>
        <select
          id="preview-days"
          value={days}
          style={CONTROL}
          onChange={(event) => setDays(event.target.value)}
        >
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {d === 1 ? "1 day" : `${d} days`}
            </option>
          ))}
        </select>
        <Button onPress={() => void make()}>Create a share link</Button>
      </div>
      {problem ? <Alert color="danger" title="No link made" description={problem} /> : null}
      {link ? (
        <>
          <div style={ROW}>
            <label htmlFor="preview-link">Share link</label>
            <input
              id="preview-link"
              type="text"
              readOnly
              value={link.url}
              style={{ ...CONTROL, width: "100%", maxWidth: "40rem" }}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button onPress={() => void copy()}>Copy</Button>
          </div>
          <p>
            Anyone with this link can see the saved version of this page until{" "}
            {new Date(link.expiresAt).toLocaleDateString("en", { dateStyle: "long" })}. It is not
            shown to search engines.
          </p>
        </>
      ) : null}
      <p role="status">{note}</p>
    </section>
  );
}
